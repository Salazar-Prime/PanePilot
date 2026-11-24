import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationIndexer } from '../src/main/conversation-indexer'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { Store } from '../src/main/store'
import { TerminalManager } from '../src/main/terminal-manager'
import { panePilotTmuxMetadata, type ListedTmuxSession } from '../src/main/tmux-metadata'
import type { Connection } from '../src/shared/types'

interface Internals {
  tmuxPathForConnection(connection: Connection): Promise<string | null>
  listLocalTmuxSessions(): Promise<ListedTmuxSession[] | null>
  readRemoteTmuxSessions(connection: Connection): Promise<ListedTmuxSession[] | null>
  listRemoteTmuxSessions(connection: Connection): Promise<ListedTmuxSession[] | null>
  execCommand(file: string, args: string[], options: unknown): Promise<{ stdout: string; stderr: string }>
}

// All tmux/SSH work is replaced at the command boundary; only disposable SQLite
// is real. No user sessions or provider conversations are opened or changed.
describe('identity-safe terminal rename', () => {
  let root: string | undefined
  let store: Store | undefined
  let manager: TerminalManager | undefined
  afterEach(() => {
    manager?.shutdown()
    store?.close()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  function fixture(kind: 'local' | 'ssh' = 'ssh') {
    vi.stubEnv('SHELL', '')
    root = mkdtempSync(join(tmpdir(), 'panepilot-rename-'))
    store = new Store(root)
    store.syncConnections(['fixture-mac'])
    const project = store.createProject({ type: 'terminal', name: 'Rename fixture', folder: '/srv/paper',
      connectionId: kind === 'local' ? 'local' : 'ssh:fixture-mac', repositoryUrl: null })
    const session = store.createSession({ projectId: project.id, name: 'panepilot - NEW UI', profile: 'codex',
      kind: 'terminal', backend: 'tmux', tmuxName: 'panepilot - NEW UI', dangerousMode: true,
      providerSessionName: null, customCommand: null })
    const providerId = randomUUID()
    store.setSessionProviderId(session.id, 'codex', providerId)
    const metadata = panePilotTmuxMetadata({ project, session: store.getSessionWithoutOutput(session.id)!, action: null, latexSection: null })
    let listing: ListedTmuxSession[] = [{ tmuxId: '$7', name: session.name, attachedClients: 2,
      paneTitle: '', paneCurrentCommand: 'codex', paneDead: false, metadata }]
    const send = vi.fn()
    manager = new TerminalManager(store, () => ({ webContents: { send } }) as unknown as BrowserWindow,
      new ConversationIndexer(), new RemoteConversationIndexer())
    const internals = manager as unknown as Internals
    vi.spyOn(internals, 'tmuxPathForConnection').mockResolvedValue('/fixture/tmux')
    const read = vi.spyOn(internals, kind === 'local' ? 'listLocalTmuxSessions' : 'readRemoteTmuxSessions')
      .mockImplementation(async () => structuredClone(listing))
    const command = vi.spyOn(internals, 'execCommand').mockResolvedValue({ stdout: '', stderr: '' })
    return { store, manager, internals, project, session, providerId, send, read, command,
      listing: () => listing, set: (next: ListedTmuxSession[]) => { listing = next } }
  }

  it.each(['local', 'ssh'] as const)('renames the exact %s tmux ID and preserves conversation and permission state', async (kind) => {
    const f = fixture(kind)
    const name = "panepilot - NEW UI 2 🛠 user's"
    await f.manager.rename(f.session.id, name)
    expect(f.command).toHaveBeenCalledOnce()
    const [file, args] = f.command.mock.calls[0]
    if (kind === 'local') {
      expect(file).toBe('/fixture/tmux')
      expect(args).toEqual(['-u', 'rename-session', '-t', '$7', name])
    } else {
      expect(file).toBe('ssh')
      expect(args).toContain('fixture-mac')
      expect(args.at(-1)).toContain("'-u' 'rename-session' '-t' '$7'")
      expect(args.at(-1)).toContain("user'\\''s")
    }
    expect(f.store.getSessionWithoutOutput(f.session.id)).toMatchObject({ id: f.session.id, name,
      tmuxName: name, providerSessionId: f.providerId, dangerousMode: true, state: 'idle' })
    expect(f.send).toHaveBeenCalledWith('terminal:metadata', { sessionId: f.session.id, projectId: f.project.id })
  })

  it('accepts a rename already applied elsewhere, even when another session now occupies the old name', async () => {
    const f = fixture()
    const own = f.listing()[0]
    f.set([{ ...own, name: 'panepilot - NEW UI 2' },
      { ...own, tmuxId: '$8', metadata: { ...own.metadata!, terminalId: randomUUID() } }])
    await f.manager.rename(f.session.id, 'panepilot - NEW UI 2')
    expect(f.command).not.toHaveBeenCalled()
    expect(f.store.getSessionWithoutOutput(f.session.id)?.tmuxName).toBe('panepilot - NEW UI 2')
  })

  it('follows an external rename by UUID instead of renaming the stale name occupant', async () => {
    const f = fixture()
    const own = f.listing()[0]
    f.set([{ ...own, name: 'Renamed from the other laptop' },
      { ...own, tmuxId: '$8', metadata: { ...own.metadata!, terminalId: randomUUID() } }])
    await f.manager.rename(f.session.id, 'Final name')
    expect(f.command.mock.calls[0][1].at(-1)).toContain("'-t' '$7' 'Final name'")
  })

  it.each([true, false])('rejects a genuinely occupied destination (source present: %s)', async (sourcePresent) => {
    const f = fixture()
    const own = f.listing()[0]
    f.set([...(sourcePresent ? [own] : []), { ...own, tmuxId: '$8', name: 'Taken', metadata: null }])
    await expect(f.manager.rename(f.session.id, 'Taken')).rejects.toThrow('already exists')
    expect(f.command).not.toHaveBeenCalled()
    expect(f.store.getSessionWithoutOutput(f.session.id)?.name).toBe(f.session.name)
  })

  it.each(['other UUID', 'other project', 'missing metadata', 'duplicate UUID'])('does not rename a backend with %s', async (conflict) => {
    const f = fixture()
    const own = f.listing()[0]
    if (conflict === 'other UUID') own.metadata!.terminalId = randomUUID()
    if (conflict === 'other project') own.metadata!.projectPath = '/srv/unrelated'
    if (conflict === 'missing metadata') own.metadata = null
    if (conflict === 'duplicate UUID') f.set([own, { ...own, tmuxId: '$8', name: 'Duplicate identity' }])
    await expect(f.manager.rename(f.session.id, 'New name')).rejects.toThrow(/unverified|Multiple/)
    expect(f.command).not.toHaveBeenCalled()
    expect(f.store.getSessionWithoutOutput(f.session.id)?.name).toBe(f.session.name)
  })

  it('renames a saved, absent backend without starting it', async () => {
    const f = fixture()
    f.set([])
    await f.manager.rename(f.session.id, 'Resume later')
    expect(f.command).not.toHaveBeenCalled()
    expect(f.store.getSessionWithoutOutput(f.session.id)).toMatchObject({ name: 'Resume later', tmuxName: 'Resume later' })
  })

  it.each([false, true])('waits for an in-progress metadata write (already renamed: %s)', async (alreadyRenamed) => {
    const f = fixture()
    if (alreadyRenamed) f.set([{ ...f.listing()[0], name: 'New name' }])
    f.read.mockResolvedValueOnce([{ ...f.listing()[0], metadata: null }])
    await f.manager.rename(f.session.id, 'New name')
    expect(f.read).toHaveBeenCalledTimes(2)
    if (alreadyRenamed) expect(f.command).not.toHaveBeenCalled()
    else expect(f.command.mock.calls[0][1].at(-1)).toContain("'-t' '$7' 'New name'")
    expect(f.store.getSessionWithoutOutput(f.session.id)?.name).toBe('New name')
  })

  it('leaves SQLite unchanged when SSH cannot verify the host', async () => {
    const f = fixture()
    f.read.mockResolvedValue(null)
    await expect(f.manager.rename(f.session.id, 'New name')).rejects.toThrow('Could not verify')
    expect(f.command).not.toHaveBeenCalled()
    expect(f.store.getSessionWithoutOutput(f.session.id)?.name).toBe(f.session.name)
  })

  it('recovers an SSH response lost after the exact backend was renamed', async () => {
    const f = fixture()
    f.command.mockImplementation(async () => {
      f.set([{ ...f.listing()[0], name: 'New name' }])
      throw new Error('SSH response lost')
    })
    await f.manager.rename(f.session.id, 'New name')
    expect(f.read).toHaveBeenCalledTimes(2)
    expect(f.store.getSessionWithoutOutput(f.session.id)?.name).toBe('New name')
  })

  it.each(['unchanged', 'other backend', 'offline'])('does not mask a failed rename when the follow-up snapshot is %s', async (after) => {
    const f = fixture()
    f.command.mockImplementation(async () => {
      if (after === 'other backend') f.set([{ ...f.listing()[0], name: 'New name', tmuxId: '$8' }])
      if (after === 'offline') f.read.mockResolvedValue(null)
      throw new Error('Rename failed')
    })
    await expect(f.manager.rename(f.session.id, 'New name')).rejects.toThrow('Rename failed')
    expect(f.store.getSessionWithoutOutput(f.session.id)?.name).toBe(f.session.name)
  })

  it('does not let an older discovery snapshot undo a completed rename', async () => {
    const f = fixture()
    const oldSnapshot = structuredClone(f.listing())
    let finish!: (listing: ListedTmuxSession[]) => void
    f.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const discovery = f.manager.reconcileSessions('ssh:fixture-mac')
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce())
    await f.manager.rename(f.session.id, 'New name')
    finish(oldSnapshot)
    expect(await discovery).toBe(0)
    expect(f.store.getSessionWithoutOutput(f.session.id)).toMatchObject({ name: 'New name', tmuxName: 'New name' })
  })

  it('invalidates pre-rename reads for the next attach without an old response clearing a newer shared read', async () => {
    const f = fixture()
    const connection = f.store.getConnection(f.project.connectionId)!
    let finishOld!: (listing: ListedTmuxSession[]) => void
    f.read.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve }))
    const oldRead = f.internals.listRemoteTmuxSessions(connection)
    await f.manager.rename(f.session.id, 'New name')
    let finishNew!: (listing: ListedTmuxSession[]) => void
    f.read.mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve }))
    const newRead = f.internals.listRemoteTmuxSessions(connection)
    expect(newRead).not.toBe(oldRead)
    expect(f.read).toHaveBeenCalledTimes(3)
    finishOld(f.listing())
    await oldRead
    expect(f.internals.listRemoteTmuxSessions(connection)).toBe(newRead)
    finishNew([{ ...f.listing()[0], name: 'New name' }])
    expect((await newRead)?.[0].name).toBe('New name')
  })
})
