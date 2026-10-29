import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationIndexer } from '../src/main/conversation-indexer'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import type { ConnectionRetryCoordinator } from '../src/main/connection-retry-coordinator'
import { Store } from '../src/main/store'
import { TerminalManager } from '../src/main/terminal-manager'
import type { ListedTmuxSession } from '../src/main/tmux-metadata'
import type { Connection, TerminalSession } from '../src/shared/types'

interface Reconnect {
  sessionId: string
  connectionId: string
  cols: number
  rows: number
  attempt: number
  lastExitCode: number
  transportState: 'reconnecting' | 'offline'
}

interface Internals {
  reconnects: Map<string, Reconnect>
  connectionRetries: ConnectionRetryCoordinator
  listRemoteTmuxSessions(connection: Connection): Promise<ListedTmuxSession[] | null>
  readRemoteTmuxSessions(connection: Connection): Promise<ListedTmuxSession[] | null>
  beginRemoteReconnect(id: string, cols: number, rows: number, exitCode: number, immediate?: boolean): void
  cancelReconnect(id: string): void
  launch(session: TerminalSession, folder: string, connection: Connection, cols: number, rows: number, create: boolean): Promise<void>
}

describe('remote reconnect connection rounds', () => {
  let root: string | null = null
  let store: Store | null = null
  let manager: TerminalManager | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv('SHELL', '/panepilot-reconnect-fixture-no-shell')
  })
  afterEach(() => {
    manager?.shutdown()
    store?.close()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.useRealTimers()
    if (root) rmSync(root, { recursive: true, force: true })
    root = null
    store = null
    manager = null
  })

  async function fixture(sessionCount = 2) {
    root = mkdtempSync(join(tmpdir(), 'panepilot-reconnect-coalescing-'))
    store = new Store(root)
    store.syncConnections(['host-one', 'host-two'])
    const createSessions = (host: string, count: number) => {
      const project = store!.createProject({
        type: 'terminal', name: host, connectionId: `ssh:${host}`,
        folder: '/srv/project', repositoryUrl: null
      })
      return Array.from({ length: count }, (_, index) => store!.createSession({
        projectId: project.id, name: `terminal-${host}-${index}`, profile: 'shell', backend: 'tmux',
        tmuxName: `terminal-${host}-${index}`, dangerousMode: false, providerSessionName: null, customCommand: null
      }))
    }
    const sessions = createSessions('host-one', sessionCount)
    manager = new TerminalManager(store, () => null, new ConversationIndexer(), new RemoteConversationIndexer())
    const internals = manager as unknown as Internals
    const launch = vi.spyOn(internals, 'launch').mockResolvedValue()
    await vi.advanceTimersByTimeAsync(0)
    const begin = (session: TerminalSession, immediate = false, exitCode = 255) =>
      internals.beginRemoteReconnect(session.id, 90, 25, exitCode, immediate)
    return { store, manager, internals, sessions, launch, begin, createSessions }
  }

  const snapshot = (sessions: TerminalSession[]) => sessions.map((session) => ({
    name: session.tmuxName, metadata: { terminalId: session.id }
  } as ListedTmuxSession))

  it('uses one clock and one snapshot for twenty reconnecting sessions and checks each exact identity', async () => {
    const f = await fixture(20)
    let resolve!: (value: ListedTmuxSession[] | null) => void
    const read = vi.spyOn(f.internals, 'readRemoteTmuxSessions').mockReturnValue(new Promise((done) => { resolve = done }))
    for (const session of f.sessions) f.begin(session)
    expect(f.internals.connectionRetries.size).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toHaveBeenCalledTimes(1)
    resolve(snapshot(f.sessions))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.launch.mock.calls.map(([session]) => session.id)).toEqual(f.sessions.map((session) => session.id))
    expect(f.internals.reconnects.size).toBe(0)
    expect(f.internals.connectionRetries.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(f.sessions.every((session) => f.store.getSession(session.id)?.state === 'idle')).toBe(true)
  })

  it('backs off one offline host across many tabs, preserving terminal state and honoring explicit retry', async () => {
    const f = await fixture(20)
    const read = vi.spyOn(f.internals, 'readRemoteTmuxSessions').mockResolvedValue(null)
    for (const session of f.sessions) f.begin(session)
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)
    for (const reconnect of f.internals.reconnects.values()) {
      expect(reconnect).toMatchObject({ attempt: 1, transportState: 'offline' })
      expect(f.store.getSession(reconnect.sessionId)?.state).toBe('idle')
    }
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)
    for (const session of f.sessions) f.begin(session)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(3)
    f.begin(f.sessions[0], true)
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(4)
    expect(f.launch).not.toHaveBeenCalled()
    expect(f.internals.reconnects.size).toBe(20)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('never attaches a same-name session owned by a different terminal', async () => {
    const f = await fixture()
    vi.spyOn(f.internals, 'readRemoteTmuxSessions').mockResolvedValue([
      { name: f.sessions[0].tmuxName, metadata: { terminalId: f.sessions[1].id } } as ListedTmuxSession,
      { name: f.sessions[1].tmuxName, metadata: { terminalId: f.sessions[1].id } } as ListedTmuxSession
    ])
    for (const session of f.sessions) f.begin(session)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.launch.mock.calls.map(([session]) => session.id)).toEqual([f.sessions[1].id])
    expect(f.store.getSession(f.sessions[0].id)?.state).toBe('error')
    expect(f.store.getSession(f.sessions[1].id)?.state).toBe('idle')
    expect(f.internals.connectionRetries.size).toBe(0)
  })

  it('keeps hosts independent and cancels only the clock whose last session leaves', async () => {
    const f = await fixture(12)
    const second = f.createSessions('host-two', 8)
    const read = vi.spyOn(f.internals, 'readRemoteTmuxSessions').mockResolvedValue(null)
    for (const session of [...f.sessions, ...second]) f.begin(session)
    expect(vi.getTimerCount()).toBe(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(read.mock.calls.map(([connection]) => connection.id)).toEqual(['ssh:host-one', 'ssh:host-two'])
    for (const session of f.sessions.slice(0, -1)) f.internals.cancelReconnect(session.id)
    expect(vi.getTimerCount()).toBe(2)
    f.internals.cancelReconnect(f.sessions.at(-1)!.id)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(read.mock.calls.map(([connection]) => connection.id)).toEqual(['ssh:host-one', 'ssh:host-two', 'ssh:host-two'])
  })

  it('retains a failed attachment in the existing host backoff instead of starting another immediate round', async () => {
    const f = await fixture()
    const read = vi.spyOn(f.internals, 'readRemoteTmuxSessions').mockResolvedValue(snapshot(f.sessions))
    f.launch.mockRejectedValue(new Error('Fixture attach transport failed'))
    for (const session of f.sessions) f.begin(session)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.launch).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenCalledTimes(1)
    expect(f.internals.reconnects.size).toBe(2)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(read).toHaveBeenCalledTimes(1)
    f.launch.mockResolvedValue()
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)
    expect(f.internals.reconnects.size).toBe(0)
    expect(f.internals.connectionRetries.size).toBe(0)
  })

  it('preserves a session joining an in-flight round and never launches a canceled participant', async () => {
    const f = await fixture(3)
    let resolve!: (value: ListedTmuxSession[] | null) => void
    const read = vi.spyOn(f.internals, 'readRemoteTmuxSessions')
      .mockReturnValueOnce(new Promise((done) => { resolve = done }))
      .mockResolvedValue(snapshot(f.sessions))
    f.begin(f.sessions[0])
    f.begin(f.sessions[1])
    await vi.advanceTimersByTimeAsync(0)
    f.begin(f.sessions[2], true)
    f.internals.cancelReconnect(f.sessions[0].id)
    resolve(snapshot(f.sessions))
    await vi.advanceTimersByTimeAsync(1)
    expect(f.launch.mock.calls.map(([session]) => session.id)).toEqual([f.sessions[1].id, f.sessions[2].id])
    expect(read).toHaveBeenCalledTimes(2)
    expect(f.internals.connectionRetries.size).toBe(0)
  })

  it('cancels all clocks at shutdown and discards the late snapshot without launching or completing sessions', async () => {
    const f = await fixture(8)
    let resolve!: (value: ListedTmuxSession[] | null) => void
    const read = vi.spyOn(f.internals, 'readRemoteTmuxSessions').mockReturnValue(new Promise((done) => { resolve = done }))
    for (const session of f.sessions) f.begin(session)
    await vi.advanceTimersByTimeAsync(0)
    f.manager.shutdown()
    resolve([])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(read).toHaveBeenCalledTimes(1)
    expect(f.launch).not.toHaveBeenCalled()
    expect(f.internals.connectionRetries.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(f.sessions.every((session) => f.store.getSession(session.id)?.state === 'idle')).toBe(true)
  })

  it('still coalesces discovery reads with the same host and performs a fresh read after settlement', async () => {
    const f = await fixture()
    const read = vi.spyOn(f.internals, 'readRemoteTmuxSessions').mockResolvedValue([])
    const one = f.store.getConnection('ssh:host-one')!
    const two = f.store.getConnection('ssh:host-two')!
    await Promise.all([
      f.internals.listRemoteTmuxSessions(one),
      f.internals.listRemoteTmuxSessions(one),
      f.internals.listRemoteTmuxSessions(two)
    ])
    expect(read.mock.calls.map(([connection]) => connection.id)).toEqual([one.id, two.id])
    await f.internals.listRemoteTmuxSessions(one)
    expect(read).toHaveBeenCalledTimes(3)
  })
})
