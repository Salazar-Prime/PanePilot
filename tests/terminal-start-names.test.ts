import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { Store } from '../src/main/store'
import { TerminalManager } from '../src/main/terminal-manager'

// Fake every SSH/tmux/PTY operation. Only the disposable SQLite database is real.
const subprocess = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: subprocess.execFile
  })
}))

describe('bounded terminal creation', () => {
  let root: string
  let store: Store
  let manager: TerminalManager
  let projectId: string
  let names: string[]
  const tmuxPath = '/fixture/tmux'
  const missingSession = () => Object.assign(new Error('No session'), { code: 1 })

  beforeEach(() => {
    vi.stubEnv('SHELL', '')
    root = mkdtempSync(join(tmpdir(), 'panepilot-start-names-'))
    store = new Store(root)
    store.syncConnections(['fixture-host'])
    projectId = store.createProject({ type: 'terminal', name: 'Remote',
      connectionId: 'ssh:fixture-host', folder: '/srv/project', repositoryUrl: null }).id
    manager = new TerminalManager(store, () => null,
      { findProviderSessionId: vi.fn().mockReturnValue(null) }, new RemoteConversationIndexer())
    names = []
    subprocess.execFile.mockImplementation(async (_file, args: string[]) => {
      const command = args.at(-1) ?? ''
      if (command.includes('list-sessions') || args.includes('list-sessions')) {
        return { stdout: names.join('\n'), stderr: '' }
      }
      // Old implementation would probe each name; never let a regression hang the test.
      if (command.includes('has-session') || args.includes('has-session')) throw missingSession()
      if (command.includes('panepilot_tmux')) return { stdout: `${tmuxPath}\n`, stderr: '' }
      throw new Error(`Unexpected subprocess: ${args.join(' ')}`)
    })
    vi.mocked(pty.spawn).mockImplementation(() => ({
      pid: 1, cols: 100, rows: 30, process: 'fixture', handleFlowControl: false,
      onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
      write() {}, resize() {}, kill() {}, pause() {}, resume() {}, clear() {}
    }))
  })

  afterEach(() => {
    manager.shutdown()
    store.close()
    rmSync(root, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  const start = (name = 'New terminal') => manager.start({ projectId, name, profile: 'shell', dangerousMode: false })
  const nameReads = () => subprocess.execFile.mock.calls.filter(([, args]) =>
    (args as string[]).join(' ').includes('list-sessions'))

  it.each(['local', 'ssh'] as const)('chooses a free %s name from one snapshot, even with many collisions', async (kind) => {
    if (kind === 'local') {
      projectId = store.createProject({ type: 'terminal', name: 'Local',
        connectionId: 'local', folder: root, repositoryUrl: null }).id
      ;(manager as unknown as { tmuxPath: string }).tmuxPath = tmuxPath
    }
    names = ['New terminal', ...Array.from({ length: 199 }, (_, index) => `New terminal ${index + 2}`)]
    const created = await start()
    expect(created.name).toBe('New terminal 201')
    expect(nameReads()).toHaveLength(1)
    expect(subprocess.execFile.mock.calls.some(([, args]) => (args as string[]).join(' ').includes('has-session'))).toBe(false)
    expect(pty.spawn).toHaveBeenCalledOnce()
  })

  it('reserves pending and stopped names across projects on the same host', async () => {
    const first = await start()
    store.setSessionState(first.id, 'completed')
    projectId = store.createProject({ type: 'terminal', name: 'Other project',
      connectionId: 'ssh:fixture-host', folder: '/srv/other', repositoryUrl: null }).id
    const second = await start()
    expect(second.name).toBe('New terminal 2')
    expect(nameReads()).toHaveLength(2)
    expect(store.getSessionWithoutOutput(first.id)?.name).toBe('New terminal')
  })

  it('serializes rapid requests even before the first backend appears in tmux', async () => {
    const results = await Promise.all([start(), start(), start()])
    expect(results.map((session) => session.name)).toEqual(['New terminal', 'New terminal 2', 'New terminal 3'])
  })

  it('does not get stuck when an SSH has-session probe would always report success', async () => {
    let probes = 0
    subprocess.execFile.mockImplementation(async (_file, args: string[]) => {
      const command = args.at(-1) ?? ''
      if (command.includes('has-session')) {
        if (++probes > 8) throw new Error('Unbounded session-name probing')
        return { stdout: '', stderr: '' }
      }
      if (command.includes('list-sessions')) return { stdout: 'New terminal\nNew terminal 2\n', stderr: '' }
      return { stdout: `${tmuxPath}\n`, stderr: '' }
    })
    expect((await start()).name).toBe('New terminal 3')
    expect(probes).toBe(0)
    expect(nameReads()).toHaveLength(1)
    expect(nameReads()[0][2]).toMatchObject({ timeout: 12_000, maxBuffer: 1024 * 1024 })
    expect(nameReads()[0][1].at(-1)).toContain(`exec '${tmuxPath}' '-u' 'list-sessions'`)
  })

  it('does not reserve a name from a different connection', async () => {
    const localProject = store.createProject({ type: 'terminal', name: 'Local',
      connectionId: 'local', folder: root, repositoryUrl: null })
    store.createSession({ projectId: localProject.id, name: 'New terminal', tmuxName: 'New terminal',
      backend: 'tmux', profile: 'shell', dangerousMode: false, providerSessionName: null, customCommand: null })
    expect((await start()).name).toBe('New terminal')
  })

  it('retains Unicode and shell quoting while fitting the suffix in the name limit', async () => {
    const base = `Writer's 🛠 ${'x'.repeat(68)}`.slice(0, 80)
    names = [base]
    const session = await start(base)
    expect(session.name).toHaveLength(80)
    expect(session.name).toBe(`${base.slice(0, 78)} 2`)
    const command = vi.mocked(pty.spawn).mock.calls[0][1]?.at(-1)
    expect(command).toContain("Writer'\\''s 🛠")
    expect(command).toContain('-u new-session')
  })

  it.each([
    { code: 255, stderr: 'ssh: Could not resolve hostname fixture-host' },
    { code: 255, stderr: 'Permission denied (publickey).' },
    { killed: true, signal: 'SIGTERM', stderr: '' },
    { code: 127, stderr: 'remote shell startup failed' }
  ])('reports failed SSH resolution without creating a phantom PTY ($code $stderr)', async (failure) => {
    subprocess.execFile.mockRejectedValue(Object.assign(new Error('SSH lookup failed'), failure))
    await expect(start()).rejects.toThrow(/Could not check tmux on fixture-host/)
    expect(pty.spawn).not.toHaveBeenCalled()
    expect(store.getProjectForRuntime(projectId)?.sessions).toHaveLength(0)
  })

  it('allows the PTY fallback only when the remote check explicitly reports missing tmux', async () => {
    subprocess.execFile.mockResolvedValue({ stdout: 'PANEPILOT_TMUX_UNAVAILABLE\n', stderr: '' })
    const session = await start()
    expect(session.backend).toBe('pty')
    expect(subprocess.execFile).toHaveBeenCalledOnce()
    expect(nameReads()).toHaveLength(0)
    expect(vi.mocked(pty.spawn).mock.calls[0][1]?.at(-1)).not.toContain('new-session')
  })

  it('rejects invalid successful lookup output instead of silently switching to PTY', async () => {
    subprocess.execFile.mockResolvedValue({ stdout: 'welcome to the host\n', stderr: '' })
    await expect(start()).rejects.toThrow(/Could not check tmux/)
    expect(pty.spawn).not.toHaveBeenCalled()
  })

  it('allows first creation on a host with no running tmux server', async () => {
    subprocess.execFile.mockImplementation(async (_file, args: string[]) => {
      if (args.at(-1)?.includes('list-sessions')) {
        throw Object.assign(new Error('No server'), { code: 1, stderr: 'no server running on /tmp/fixture-socket' })
      }
      if (args.at(-1)?.includes('has-session')) throw missingSession()
      return { stdout: `${tmuxPath}\n`, stderr: '' }
    })
    expect((await start()).backend).toBe('tmux')
  })

  it('surfaces a failed name snapshot before saving a tab, then permits a retry', async () => {
    ;(manager as unknown as { remoteTmuxPaths: Map<string, string> }).remoteTmuxPaths.set('ssh:fixture-host', tmuxPath)
    subprocess.execFile.mockRejectedValueOnce(Object.assign(new Error('SSH timed out'), { code: 255 }))
    await expect(start()).rejects.toThrow()
    expect(pty.spawn).not.toHaveBeenCalled()
    expect(store.getProjectForRuntime(projectId)?.sessions).toHaveLength(0)
    expect((await start()).name).toBe('New terminal')
  })
})
