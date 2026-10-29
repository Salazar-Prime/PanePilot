import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationIndexer } from '../src/main/conversation-indexer'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { Store } from '../src/main/store'
import { TerminalManager } from '../src/main/terminal-manager'
import type { ListedTmuxSession } from '../src/main/tmux-metadata'
import type { Connection, TerminalSession } from '../src/shared/types'

interface Reconnect {
  sessionId: string
  cols: number
  rows: number
  attempt: number
  lastExitCode: number
  timer: NodeJS.Timeout | null
  transportState: 'reconnecting' | 'offline'
}

interface Internals {
  reconnects: Map<string, Reconnect>
  listRemoteTmuxSessions(connection: Connection): Promise<ListedTmuxSession[] | null>
  readRemoteTmuxSessions(connection: Connection): Promise<ListedTmuxSession[] | null>
  runRemoteReconnect(reconnect: Reconnect): Promise<void>
  launch(session: TerminalSession, folder: string, connection: Connection, cols: number, rows: number, create: boolean): void
}

describe('remote reconnect scan coalescing', () => {
  let root: string | null = null
  let store: Store | null = null
  let manager: TerminalManager | null = null

  afterEach(() => {
    manager?.shutdown()
    store?.close()
    vi.restoreAllMocks()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  function fixture() {
    root = mkdtempSync(join(tmpdir(), 'panepilot-reconnect-coalescing-'))
    store = new Store(root)
    store.syncConnections(['host-one', 'host-two'])
    const project = store.createProject({
      type: 'terminal', name: 'Remote', connectionId: 'ssh:host-one',
      folder: '/srv/project', repositoryUrl: null
    })
    const sessions = ['one', 'two'].map((name) => store!.createSession({
      projectId: project.id, name, profile: 'shell', backend: 'tmux',
      tmuxName: name, dangerousMode: false, providerSessionName: null, customCommand: null
    }))
    manager = new TerminalManager(store, () => null, new ConversationIndexer(), new RemoteConversationIndexer())
    const internals = manager as unknown as Internals
    const launch = vi.spyOn(internals, 'launch').mockImplementation(() => {})
    const reconnects = sessions.map((session): Reconnect => ({
      sessionId: session.id, cols: 90, rows: 25, attempt: 0, lastExitCode: 255,
      timer: null, transportState: 'reconnecting'
    }))
    for (const reconnect of reconnects) internals.reconnects.set(reconnect.sessionId, reconnect)
    return { store, internals, sessions, reconnects, launch }
  }

  it('shares a host snapshot between reconnecting terminals while checking each exact identity', async () => {
    const f = fixture()
    let resolve!: (value: ListedTmuxSession[] | null) => void
    const read = vi.spyOn(f.internals, 'readRemoteTmuxSessions').mockReturnValue(new Promise((done) => { resolve = done }))
    const pending = f.reconnects.map((reconnect) => f.internals.runRemoteReconnect(reconnect))
    expect(read).toHaveBeenCalledTimes(1)
    resolve(f.sessions.map((session) => ({
      name: session.tmuxName, metadata: { terminalId: session.id }
    } as ListedTmuxSession)))
    await Promise.all(pending)
    expect(f.launch.mock.calls.map(([session]) => session.id)).toEqual(f.sessions.map((session) => session.id))
    expect(f.internals.reconnects.size).toBe(0)
    expect(f.sessions.every((session) => f.store.getSession(session.id)?.state === 'idle')).toBe(true)
  })

  it('keeps all terminals retryable when a shared host read fails', async () => {
    const f = fixture()
    const read = vi.spyOn(f.internals, 'readRemoteTmuxSessions').mockResolvedValue(null)
    await Promise.all(f.reconnects.map((reconnect) => f.internals.runRemoteReconnect(reconnect)))
    expect(read).toHaveBeenCalledTimes(1)
    expect(f.launch).not.toHaveBeenCalled()
    for (const reconnect of f.reconnects) {
      expect(reconnect).toMatchObject({ attempt: 1, transportState: 'offline' })
      expect(reconnect.timer).not.toBeNull()
      expect(f.store.getSession(reconnect.sessionId)?.state).toBe('idle')
    }
  })

  it('never attaches a same-name session owned by a different terminal', async () => {
    const f = fixture()
    vi.spyOn(f.internals, 'readRemoteTmuxSessions').mockResolvedValue([
      { name: f.sessions[0].tmuxName, metadata: { terminalId: f.sessions[1].id } } as ListedTmuxSession,
      { name: f.sessions[1].tmuxName, metadata: { terminalId: f.sessions[1].id } } as ListedTmuxSession
    ])
    await Promise.all(f.reconnects.map((reconnect) => f.internals.runRemoteReconnect(reconnect)))
    expect(f.launch.mock.calls.map(([session]) => session.id)).toEqual([f.sessions[1].id])
    expect(f.store.getSession(f.sessions[0].id)?.state).toBe('error')
    expect(f.store.getSession(f.sessions[1].id)?.state).toBe('idle')
  })

  it('separates hosts and performs a fresh read after every settled attempt', async () => {
    const f = fixture()
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
