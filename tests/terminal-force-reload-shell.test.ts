import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { Store } from '../src/main/store'
import { TerminalManager } from '../src/main/terminal-manager'
import type { TerminalSession } from '../src/shared/types'

// These tests never access SSH, provider archives, or a real tmux server.
const subprocess = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: subprocess.execFile
  }),
  spawnSync: vi.fn(() => { throw new Error('Unexpected synchronous subprocess') })
}))

function fakePty() {
  return {
    pid: 1, cols: 100, rows: 30, process: 'fixture', handleFlowControl: false,
    onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(), pause: vi.fn(), resume: vi.fn(), clear: vi.fn()
  }
}

describe('Force reload for ordinary terminals and agent chats', () => {
  let root: string
  let store: Store
  let manager: TerminalManager
  let localProjectId: string
  let remoteProjectId: string
  let discoverProvider: ReturnType<typeof vi.spyOn>
  const tmuxPath = '/fixture/bin/tmux'

  function session(overrides: Partial<Parameters<Store['createSession']>[0]> = {}): TerminalSession {
    const name = `Reload ${randomUUID()}`
    return store.createSession({
      projectId: localProjectId, name, profile: 'shell', kind: 'terminal',
      backend: 'tmux', tmuxName: name, customCommand: null,
      providerSessionName: null, dangerousMode: false, ...overrides
    })
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'panepilot-force-reload-shell-'))
    store = new Store(root)
    store.syncConnections(['fixture-host'])
    localProjectId = store.createProject({ type: 'terminal', name: 'Local',
      connectionId: 'local', folder: root, repositoryUrl: null }).id
    remoteProjectId = store.createProject({ type: 'terminal', name: 'Remote',
      connectionId: 'ssh:fixture-host', folder: '/srv/remote project', repositoryUrl: null }).id
    manager = new TerminalManager(store, () => null,
      { findProviderSessionId: vi.fn().mockReturnValue(null) }, new RemoteConversationIndexer())
    const internals = manager as unknown as {
      tmuxPath: string | null
      remoteTmuxPaths: Map<string, string>
      discoverProviderSession(): Promise<boolean>
    }
    internals.tmuxPath = tmuxPath
    internals.remoteTmuxPaths.set('ssh:fixture-host', tmuxPath)
    discoverProvider = vi.spyOn(internals, 'discoverProviderSession').mockResolvedValue(false)
    vi.stubEnv('SHELL', '')
    subprocess.execFile.mockImplementation(async (file, args: string[]) => {
      if (file === tmuxPath && args[0] === 'has-session') {
        throw Object.assign(new Error('Session is missing'), { code: 1 })
      }
      if (file === 'ssh') return { stdout: '', stderr: '' }
      throw new Error(`Unexpected subprocess: ${file} ${args.join(' ')}`)
    })
    vi.mocked(pty.spawn).mockImplementation(() => fakePty())
  })

  afterEach(() => {
    manager.shutdown()
    store.close()
    rmSync(root, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it.each(['idle', 'completed', 'error'] as const)(
    'recreates a missing local tmux backend in the same %s shell tab', async (state) => {
      const chosen = session()
      store.setSessionState(chosen.id, state)
      store.setSessionPinned(chosen.id, true)
      store.setSessionFlagged(chosen.id, true)
      store.replaceOutput(chosen.id, 'Saved shell output')
      await manager.forceReloadAgent(chosen.id)
      expect(pty.spawn).toHaveBeenCalledOnce()
      const [file, args, options] = vi.mocked(pty.spawn).mock.calls[0]
      expect(file).toBe(tmuxPath)
      expect(args).toEqual(['new-session', '-s', chosen.name, '-c', root, expect.any(String)])
      expect(args?.at(-1)).toContain('exec "${SHELL:-/bin/sh}" -l')
      expect(options).toMatchObject({ cwd: root, cols: 100, rows: 30 })
      expect(store.getSession(chosen.id)).toMatchObject({ id: chosen.id,
        projectId: localProjectId, name: chosen.name, tmuxName: chosen.tmuxName,
        state: 'idle', pinned: true, flagged: true, output: 'Saved shell output' })
      expect(store.getProjectForRuntime(localProjectId)?.sessions).toHaveLength(1)
      expect(discoverProvider).not.toHaveBeenCalled()
    }
  )

  it.each(['idle', 'completed', 'error'] as const)(
    'creates a missing %s shell on its SSH host, not the viewing machine', async (state) => {
      const chosen = session({ projectId: remoteProjectId })
      store.setSessionState(chosen.id, state)
      await manager.forceReloadAgent(chosen.id)
      expect(pty.spawn).toHaveBeenCalledOnce()
      const [file, args] = vi.mocked(pty.spawn).mock.calls[0]
      expect(file).toBe('ssh')
      expect(args).toContain('fixture-host')
      expect(args?.at(-1)).toContain(`cd '/srv/remote project' && exec '${tmuxPath}' new-session -s '${chosen.name}'`)
      expect(args?.at(-1)).toContain('SHELL:-/bin/sh')
      expect(args?.at(-1)).not.toContain('codex')
      expect(args?.at(-1)).not.toContain('claude')
      expect(subprocess.execFile.mock.calls[0]).toMatchObject([
        'ssh', expect.arrayContaining(['fixture-host', expect.stringContaining(`has-session -t '=${chosen.name}'`)]),
        expect.objectContaining({ timeout: 7_000 })
      ])
      expect(store.getSession(chosen.id)).toMatchObject({ id: chosen.id, projectId: remoteProjectId, state: 'idle' })
      expect(discoverProvider).not.toHaveBeenCalled()
    }
  )

  it('keeps Retry non-destructive and lets Force reload recover the stopped tab', async () => {
    const chosen = session()
    store.setSessionState(chosen.id, 'completed')
    await expect(manager.retryAttach(chosen.id, 100, 30)).rejects.toThrow('no longer running in tmux')
    expect(pty.spawn).not.toHaveBeenCalled()
    await manager.forceReloadAgent(chosen.id)
    expect(pty.spawn).toHaveBeenCalledOnce()
    expect(store.getSession(chosen.id)?.state).toBe('idle')
  })

  it('restarts only the selected live backend and keeps its current terminal dimensions', async () => {
    const chosen = session(), sibling = session()
    await manager.attach(chosen.id, 132, 42)
    await manager.attach(sibling.id, 90, 28)
    const first = vi.mocked(pty.spawn).mock.results[0].value
    const other = vi.mocked(pty.spawn).mock.results[1].value
    let checks = 0
    subprocess.execFile.mockImplementation(async (file, args: string[]) => {
      expect(file).toBe(tmuxPath)
      expect(args).toContain(`=${chosen.tmuxName}`)
      if (args[0] === 'has-session' && checks++ > 0) {
        throw Object.assign(new Error('Stopped'), { code: 1 })
      }
      return { stdout: '', stderr: '' }
    })
    await manager.forceReloadAgent(chosen.id)
    expect(first.kill).toHaveBeenCalledOnce()
    expect(other.kill).not.toHaveBeenCalled()
    expect(subprocess.execFile.mock.calls.map((call) => call[1][0])).toEqual(['has-session', 'kill-session', 'has-session'])
    expect(vi.mocked(pty.spawn).mock.calls[2][2]).toMatchObject({ cols: 132, rows: 42, cwd: root })
    expect(store.getSession(sibling.id)?.state).toBe('idle')
  })

  it.each(['codex', 'claude'] as const)('still resumes the exact saved %s chat over SSH', async (profile) => {
    const chosen = session({ projectId: remoteProjectId, profile, dangerousMode: true })
    const thread = randomUUID()
    store.setSessionProviderId(chosen.id, profile, thread)
    store.setSessionState(chosen.id, 'completed')
    await manager.forceReloadAgent(chosen.id)
    const command = vi.mocked(pty.spawn).mock.calls[0][1]?.at(-1)
    expect(command).toContain('new-session -s')
    expect(command).toContain('resume')
    expect(command).toContain(thread)
    expect(command).toContain(profile === 'codex'
      ? '--dangerously-bypass-approvals-and-sandbox' : '--dangerously-skip-permissions')
    expect(store.getSession(chosen.id)).toMatchObject({ providerSessionId: thread, dangerousMode: true, state: 'idle' })
    expect(discoverProvider).not.toHaveBeenCalled()
  })

  it('does not create a replacement when SSH cleanup cannot establish that the target stopped', async () => {
    const chosen = session({ projectId: remoteProjectId })
    subprocess.execFile.mockRejectedValue(new Error('SSH host is offline'))
    await expect(manager.forceReloadAgent(chosen.id)).rejects.toThrow('SSH host is offline')
    expect(pty.spawn).not.toHaveBeenCalled()
    expect(store.getSession(chosen.id)).toMatchObject({ id: chosen.id, projectId: remoteProjectId, state: 'error' })
  })

  it('leaves a failed launch in the same tab so Force reload can be retried', async () => {
    const chosen = session()
    vi.mocked(pty.spawn).mockImplementationOnce(() => { throw new Error('spawn failed') })
    await expect(manager.forceReloadAgent(chosen.id)).rejects.toThrow('spawn failed')
    expect(store.getSession(chosen.id)?.state).toBe('error')
    await manager.forceReloadAgent(chosen.id)
    expect(store.getSession(chosen.id)?.state).toBe('idle')
    expect(store.getProjectForRuntime(localProjectId)?.sessions).toHaveLength(1)
  })

  it('supports the existing PTY fallback without pretending it restored old shell processes', async () => {
    const chosen = session({ backend: 'pty', tmuxName: null })
    await manager.forceReloadAgent(chosen.id)
    expect(pty.spawn).toHaveBeenCalledWith('/bin/sh', ['-l'], expect.objectContaining({ cwd: root }))
    expect(subprocess.execFile).not.toHaveBeenCalled()
  })

  it('requires restoring archived tabs before reloading and never runs Actions through this action', async () => {
    const archived = session()
    store.setSessionState(archived.id, 'completed')
    store.setSessionArchived(archived.id, true)
    await expect(manager.forceReloadAgent(archived.id)).rejects.toThrow('Restore the archived terminal')
    for (const profile of ['shell', 'custom'] as const) {
      const action = session({ kind: 'action', profile, customCommand: 'never execute' })
      await expect(manager.forceReloadAgent(action.id)).rejects.toThrow('Only shell terminals or Codex/Claude chats')
    }
    expect(pty.spawn).not.toHaveBeenCalled()
    expect(subprocess.execFile).not.toHaveBeenCalled()
  })

  it('rejects an archived project before stopping or starting a backend', async () => {
    const chosen = session()
    store.setSessionState(chosen.id, 'completed')
    store.archiveProject(localProjectId, true)
    await expect(manager.forceReloadAgent(chosen.id)).rejects.toThrow('archived')
    expect(pty.spawn).not.toHaveBeenCalled()
    expect(subprocess.execFile).not.toHaveBeenCalled()
  })
})
