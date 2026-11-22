import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/main/store'
import { TerminalManager } from '../src/main/terminal-manager'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { encodePanePilotTmuxMetadata, panePilotTmuxMetadata, PANEPILOT_TMUX_OPTION_KEYS, TMUX_FIELD_SEPARATOR } from '../src/main/tmux-metadata'
import type { TerminalSession } from '../src/shared/types'

const subprocess = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(),
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: subprocess.exec }),
  spawnSync: vi.fn(() => { throw new Error('Unexpected synchronous subprocess') })
}))

describe('local chat power saving with disposable mocked backends', () => {
  let root: string, store: Store, manager: TerminalManager, projectId: string
  let live: Map<string, string>, screen: string
  function saved(profile: 'codex' | 'claude' | 'shell' = 'codex', project = projectId) {
    const name = `Sleep ${randomUUID()}`
    const session = store.createSession({ projectId: project, name, profile, backend: 'tmux', tmuxName: name,
      customCommand: null, providerSessionName: null, dangerousMode: profile !== 'shell' })
    if (profile !== 'shell') store.setSessionProviderId(session.id, profile, randomUUID())
    return store.getSessionWithoutOutput(session.id)!
  }
  function add(session: TerminalSession, opts: { title?: string; clients?: number; owner?: string; path?: string } = {}) {
    const id = `$${live.size + 1}`
    const metadata = panePilotTmuxMetadata({ project: store.getProjectForRuntime(session.projectId)!, session, action: null, latexSection: null })
    const encoded = encodePanePilotTmuxMetadata({ ...metadata, terminalId: opts.owner ?? session.id, projectPath: opts.path ?? root })
    live.set(id, [id, session.name, String(opts.clients ?? 0), opts.title ?? 'Ready', session.profile, '0',
      ...PANEPILOT_TMUX_OPTION_KEYS.map(key => encoded[key] ?? '')].join(TMUX_FIELD_SEPARATOR))
    return id
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'panepilot-power-saving-'))
    store = new Store(root); store.syncConnections(['other'])
    projectId = store.createProject({ type: 'terminal', name: 'Local', connectionId: 'local', folder: root, repositoryUrl: null }).id
    manager = new TerminalManager(store, () => null, { findProviderSessionId: vi.fn(() => null) }, new RemoteConversationIndexer())
    ;(manager as unknown as { tmuxPath: string }).tmuxPath = '/fixture/tmux'
    live = new Map(); screen = 'Codex ready\n\n› Ask Codex to do anything\n'
    vi.stubEnv('SHELL', '')
    subprocess.exec.mockImplementation(async (file, args: string[]) => {
      if (file !== '/fixture/tmux') throw new Error('Only isolated local tmux is permitted')
      if (args.includes('list-sessions')) return { stdout: [...live.values()].join('\n'), stderr: '' }
      if (args.includes('capture-pane')) return { stdout: screen, stderr: '' }
      if (args.includes('kill-session')) { live.delete(args.at(-1)!); return { stdout: '', stderr: '' } }
      throw new Error(`Unexpected operation: ${args.join(' ')}`)
    })
    vi.mocked(pty.spawn).mockImplementation(() => ({ pid: 1, cols: 100, rows: 30, process: 'fake', handleFlowControl: false,
      onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {}, pause() {}, resume() {}, clear() {} }))
  })
  afterEach(() => { manager.shutdown(); store.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs() })

  it('pauses only the exact local backend, keeps its identity and lazily resumes the provider chat', async () => {
    const chat = saved(), id = add(chat)
    store.setSessionPinned(chat.id, true)
    expect(await manager.suspendForPowerSaving(chat.id, Date.now() + 1, 0, () => true)).toBe(true)
    expect(subprocess.exec.mock.calls.some(([, args]) => args.join(' ') === `kill-session -t ${id}`)).toBe(true)
    expect(store.getSession(chat.id)).toMatchObject({ id: chat.id, providerSessionId: chat.providerSessionId,
      dangerousMode: true, pinned: true, archived: false, state: 'idle', recoveryPending: true })
    expect(pty.spawn).not.toHaveBeenCalled()
    await manager.reconcileSessions('local')
    expect(store.getSession(chat.id)?.recoveryPending).toBe(true)
    await manager.attach(chat.id, 100, 30)
    expect(pty.spawn).toHaveBeenCalledOnce()
    expect(vi.mocked(pty.spawn).mock.calls[0][1]?.at(-1)).toContain(chat.providerSessionId!)
    expect(store.getSession(chat.id)?.recoveryPending).toBe(false)
  })

  it('measures only local owned agent trees, coalesces reads, and collects no command arguments', async () => {
    const chat = saved(), id = add(chat)
    const shell = saved('shell'), shellId = add(shell)
    const remoteProject = store.createProject({ type: 'terminal', name: 'SSH', connectionId: 'ssh:other', folder: root, repositoryUrl: null })
    const remoteId = add(saved('codex', remoteProject.id))
    const original = subprocess.exec.getMockImplementation()!
    subprocess.exec.mockImplementation(async (file, args, ...rest) => {
      if (args.includes('list-panes')) return { stdout: `${id}\t20\t10\n${shellId}\t40\t10\n${remoteId}\t60\t10\n`, stderr: '' }
      if (args.includes('list-clients')) return { stdout: '11\n', stderr: '' }
      if (file === '/bin/ps') {
        expect(args).toEqual(['-U', String(process.getuid!()), '-o', 'pid=,ppid=,rss='])
        return { stdout: '10 1 100\n11 1 10\n20 10 1\n21 20 200\n40 10 500\n60 10 600\n', stderr: '' }
      }
      return original(file, args, ...rest)
    })
    const first = manager.localProcessMemory([]), second = manager.localProcessMemory([])
    expect(first).toBe(second)
    const result = await first
    expect(result.tmux).toMatchObject({ bytes: 110 * 1024, processCount: 2 })
    expect(result.agents).toMatchObject({ bytes: 201 * 1024, processCount: 2 })
    expect(result.agents.rows.map(row => row.id)).toEqual([chat.id])
    expect(subprocess.exec.mock.calls.filter(([file]) => file === '/bin/ps')).toHaveLength(1)
    expect(subprocess.exec.mock.calls.some(([file, args]) => file === 'ssh' || args.includes('kill-session'))).toBe(false)
  })

  it('keeps memory failures explicit and avoids process scans without live tmux', async () => {
    expect((await manager.localProcessMemory([])).agents.bytes).toBe(0)
    expect(subprocess.exec.mock.calls.some(([file]) => file === '/bin/ps')).toBe(false)
    add(saved()) // Fixture deliberately rejects list-panes and ps in this test.
    expect((await manager.localProcessMemory([])).agents).toMatchObject({ bytes: null, warning: expect.stringContaining('could not be read') })
  })

  it('preserves the floor and protects visible, externally attached, running, unread and unlinked chats', async () => {
    const chats = Array.from({ length: 7 }, () => saved())
    for (const [i, chat] of chats.entries()) add(chat, i === 1 ? { clients: 1 } : i === 2 ? { title: 'Working' } : {})
    manager.setVisible(chats[0].id, 'view-a', true)
    manager.setVisible(chats[0].id, 'view-b', true)
    manager.setVisible(chats[0].id, 'view-a', false)
    store.setSessionState(chats[3].id, 'needs-input')
    store.setSessionState(chats[4].id, 'response-ready')
    store.clearSessionProviderId(chats[5].id)
    const snapshot = await manager.powerSavingSnapshot()
    expect(snapshot.filter(chat => chat.idle).map(chat => chat.id)).toEqual([chats[6].id])
    for (const chat of chats.slice(0, 6)) expect(await manager.suspendForPowerSaving(chat.id, Date.now() + 1, 0, () => true)).toBe(false)
    expect(await manager.suspendForPowerSaving(chats[6].id, Date.now() + 1, 7, () => true)).toBe(false)
    expect(live.size).toBe(7)
  })

  it('releases its own background PTY without marking the saved chat completed', async () => {
    const chat = saved(); add(chat, { clients: 1 })
    let onExit: (event: { exitCode: number }) => void = () => {}
    const basePty = vi.mocked(pty.spawn).getMockImplementation()!
    vi.mocked(pty.spawn).mockImplementation((...args) => ({ ...basePty(...args),
      onExit: handler => { onExit = handler; return { dispose() {} } } }))
    await manager.attach(chat.id, 100, 30)
    const original = subprocess.exec.getMockImplementation()!
    subprocess.exec.mockImplementation(async (...args) => {
      const result = await original(...args)
      if (args[1].includes('kill-session')) onExit({ exitCode: 0 })
      return result
    })
    expect(await manager.suspendForPowerSaving(chat.id, Date.now() + 1, 0, () => true)).toBe(true)
    expect(store.getSession(chat.id)).toMatchObject({ state: 'idle', recoveryPending: true, providerSessionId: chat.providerSessionId })
  })

  it('excludes shells, SSH records, archived tabs, mismatched UUIDs and foreign project paths', async () => {
    add(saved('shell'))
    const foreignProject = store.createProject({ type: 'terminal', name: 'Remote', connectionId: 'ssh:other', folder: '/srv/other', repositoryUrl: null })
    add(saved('codex', foreignProject.id))
    const wrongOwner = saved(); add(wrongOwner, { owner: randomUUID() })
    const wrongPath = saved(); add(wrongPath, { path: '/other/project' })
    const archived = saved(); add(archived); store.setSessionState(archived.id, 'completed'); store.setSessionArchived(archived.id, true)
    expect(await manager.powerSavingSnapshot()).toEqual([])
    expect(subprocess.exec.mock.calls.every(([file]) => file === '/fixture/tmux')).toBe(true)
  })

  it('does not close a queued question, a busy screen, a newly visible chat, or after disabling', async () => {
    const chat = saved(); add(chat)
    screen = '• Queued follow-up inputs\n  ? 1 question · 12s\n    ⇧← to answer\n'
    expect(await manager.suspendForPowerSaving(chat.id, Date.now() + 1, 0, () => true)).toBe(false)
    screen = 'esc to interrupt'
    expect(await manager.suspendForPowerSaving(chat.id, Date.now() + 1, 0, () => true)).toBe(false)
    screen = 'Ready'
    const original = subprocess.exec.getMockImplementation()!
    subprocess.exec.mockImplementation(async (...args) => {
      const result = await original(...args)
      if (args[1].includes('capture-pane')) manager.setVisible(chat.id, 'new-view', true)
      return result
    })
    expect(await manager.suspendForPowerSaving(chat.id, Date.now() + 1, 0, () => true)).toBe(false)
    expect(await manager.suspendForPowerSaving(chat.id, Date.now() + 1, 0, () => false)).toBe(false)
    expect(live.size).toBe(1)
  })

  it('keeps settings and suspended session recovery through a store restart', async () => {
    const chat = saved('claude'); add(chat)
    store.savePowerSavingSettings({ enabled: true, idleMinutes: 15, keepAtLeast: 1 })
    await manager.suspendForPowerSaving(chat.id, Date.now() + 1, 0, () => true)
    manager.shutdown(); store.close()
    store = new Store(root)
    manager = new TerminalManager(store, () => null, { findProviderSessionId: vi.fn(() => null) }, new RemoteConversationIndexer())
    expect(store.getPowerSavingSettings()).toEqual({ enabled: true, idleMinutes: 15, keepAtLeast: 1 })
    expect(store.getSession(chat.id)).toMatchObject({ recoveryPending: true, providerSessionId: chat.providerSessionId })
  })

  it('ignores a stale discovery snapshot that finishes after the chat was paused', async () => {
    const chat = saved(); add(chat)
    const original = subprocess.exec.getMockImplementation()!
    let release!: () => void
    let first = true
    subprocess.exec.mockImplementation(async (...args) => {
      const result = await original(...args)
      if (first && args[1].includes('list-sessions')) {
        first = false
        await new Promise<void>(resolve => { release = resolve })
      }
      return result
    })
    const discovery = manager.reconcileSessions('local')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(await manager.suspendForPowerSaving(chat.id, Date.now() + 1, 0, () => true)).toBe(true)
    release(); await discovery
    expect(store.getSession(chat.id)).toMatchObject({ recoveryPending: true, state: 'idle' })
    // A genuinely new backend created by another client remains discoverable.
    add(chat)
    await manager.reconcileSessions('local')
    expect(store.getSession(chat.id)?.recoveryPending).toBe(false)
  })

  it('rechecks external attachment and the live floor after reading the screen', async () => {
    const chat = saved(), id = add(chat)
    const other = saved(), otherId = add(other)
    const original = subprocess.exec.getMockImplementation()!
    let mode = 'attached'
    subprocess.exec.mockImplementation(async (...args) => {
      const result = await original(...args)
      if (args[1].includes('capture-pane')) {
        if (mode === 'attached') {
          const fields = live.get(id)!.split(TMUX_FIELD_SEPARATOR)
          fields[2] = '1'
          live.set(id, fields.join(TMUX_FIELD_SEPARATOR))
        } else live.delete(otherId)
      }
      return result
    })
    expect(await manager.suspendForPowerSaving(chat.id, Date.now() + 1, 0, () => true)).toBe(false)
    const fields = live.get(id)!.split(TMUX_FIELD_SEPARATOR)
    fields[2] = '0'; live.set(id, fields.join(TMUX_FIELD_SEPARATOR)); mode = 'floor'
    expect(await manager.suspendForPowerSaving(chat.id, Date.now() + 1, 1, () => true)).toBe(false)
    expect(live.has(id)).toBe(true)
    expect(subprocess.exec.mock.calls.some(([, args]) => args.includes('kill-session'))).toBe(false)
  })

  it('preserves a live chat on kill failure and keeps recovery available if post-kill verification fails', async () => {
    const chat = saved(); add(chat)
    const original = subprocess.exec.getMockImplementation()!
    subprocess.exec.mockImplementation(async (...args) => {
      if (args[1].includes('kill-session')) throw new Error('Kill failed')
      return original(...args)
    })
    await expect(manager.suspendForPowerSaving(chat.id, Date.now() + 1, 0, () => true)).rejects.toThrow('Kill failed')
    expect(store.getSession(chat.id)?.recoveryPending).toBe(false)
    expect(live.size).toBe(1)
    let killed = false
    subprocess.exec.mockImplementation(async (...args) => {
      if (killed && args[1].includes('list-sessions')) throw new Error('Verification unavailable')
      const result = await original(...args)
      if (args[1].includes('kill-session')) killed = true
      return result
    })
    await expect(manager.suspendForPowerSaving(chat.id, Date.now() + 1, 0, () => true)).rejects.toThrow('Could not confirm')
    expect(store.getSession(chat.id)).toMatchObject({ recoveryPending: true, providerSessionId: chat.providerSessionId })
  })
})
