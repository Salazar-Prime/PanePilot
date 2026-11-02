import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationIndexer } from '../src/main/conversation-indexer'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { Store } from '../src/main/store'
import { TerminalManager } from '../src/main/terminal-manager'
import type { Connection, TerminalSessionKind } from '../src/shared/types'
import type { PanePilotTmuxMetadata } from '../src/main/tmux-metadata'
import { archivedTerminals } from '../src/renderer/src/lib/terminalArchive'

const fixtures: { path: string; store: Store; manager: TerminalManager }[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const { path, store, manager } of fixtures.splice(0)) {
    manager.shutdown(); store.close(); rmSync(path, { recursive: true, force: true })
  }
})
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'panepilot-terminal-archive-'))
  const store = new Store(path); store.syncConnections([])
  const folder = join(path, 'project'); mkdirSync(folder)
  const project = store.createProject({ type: 'terminal', name: 'Project', connectionId: 'local', folder, repositoryUrl: null })
  const other = store.createProject({ type: 'terminal', name: 'Other', connectionId: 'local', folder: path, repositoryUrl: null })
  const manager = new TerminalManager(store, () => null, new ConversationIndexer(), new RemoteConversationIndexer())
  fixtures.push({ path, store, manager })
  const session = (name: string, kind: TerminalSessionKind = 'terminal', projectId = project.id) => store.createSession({
    projectId, kind, name, profile: 'shell', providerSessionName: null, customCommand: null,
    backend: 'pty', tmuxName: null, dangerousMode: false
  })
  return { path, store, manager, project, other, session }
}

describe('per-project terminal archives', () => {
  it('stops only the chosen terminal, retaining identity, pin, flag, output and other projects', async () => {
    const { store, manager, project, other, session } = fixture()
    const chosen = session('Chosen'), sibling = session('Still running'), foreign = session('Other project', 'terminal', other.id)
    store.replaceOutput(chosen.id, '\u001b[32mSaved output\u001b[0m\r\n')
    store.setSessionPinned(chosen.id, true); store.setSessionFlagged(chosen.id, true)
    store.setSessionState(chosen.id, 'running')
    expect(() => store.setSessionArchived(chosen.id, true)).toThrow('Stop the terminal')
    await manager.archive(chosen.id)
    expect(store.getSession(chosen.id)).toMatchObject({ id: chosen.id, projectId: project.id, archived: true,
      state: 'completed', pinned: true, flagged: true, output: '\u001b[32mSaved output\u001b[0m\r\n' })
    expect(store.getSession(sibling.id)).toMatchObject({ archived: false, state: 'idle' })
    expect(store.getSession(foreign.id)).toMatchObject({ archived: false, state: 'idle' })
    expect(archivedTerminals(store.getProject(project.id)!)).toHaveLength(1)
    expect(archivedTerminals(store.getProject(other.id)!)).toEqual([])
    await expect(manager.attach(chosen.id, 100, 30)).rejects.toThrow('Restore the archived terminal')
    expect(store.setSessionState(chosen.id, 'running', 'Late hook')).toBe(false)
    await manager.restore(chosen.id)
    expect(store.getSession(chosen.id)).toMatchObject({ archived: false, state: 'completed', pinned: true, flagged: true })
    expect(store.getSession(chosen.id)?.output).toContain('Saved output')
    expect(store.getProject(project.id)?.archived).toBe(false)
  })

  it('survives reopening SQLite, and leaves provider IDs and permission mode intact', async () => {
    const { path, store, manager, project } = fixture()
    const chosen = store.createSession({ projectId: project.id, name: 'Codex saved', profile: 'codex',
      providerSessionName: null, customCommand: null,
      backend: 'pty', tmuxName: null, dangerousMode: true })
    store.setSessionProviderId(chosen.id, 'codex', 'exact-provider-thread')
    await manager.archive(chosen.id)
    const reopened = new Store(path)
    try {
      expect(reopened.getSession(chosen.id)).toMatchObject({ archived: true, providerSessionId: 'exact-provider-thread', dangerousMode: true })
      expect(reopened.isSessionPendingRebootRecovery(chosen.id)).toBe(false)
      reopened.setSessionArchived(chosen.id, false)
      expect(reopened.getSession(chosen.id)?.state).toBe('completed')
    } finally { reopened.close() }
  })

  it('never archives capability runners or restores tabs into an archived project', async () => {
    const { store, manager, project, session } = fixture()
    for (const kind of ['action', 'latex-chat', 'temporary-chat', 'project-qna'] as const) {
      const hidden = session(kind, kind)
      await expect(manager.archive(hidden.id)).rejects.toThrow('Only ordinary')
      expect(() => store.setSessionArchived(hidden.id, true)).toThrow('Only ordinary')
      store.setSessionState(hidden.id, 'completed')
    }
    const chosen = session('Chosen')
    await manager.archive(chosen.id)
    store.archiveProject(project.id, true)
    await expect(manager.restore(chosen.id)).rejects.toThrow('archived')
    expect(store.getSession(chosen.id)?.archived).toBe(true)
  })

  it('waits for the exact tmux stop, including stale completed rows, and fails safely when SSH is unavailable', async () => {
    const { store, manager, project } = fixture()
    const chosen = store.createSession({ projectId: project.id, name: 'Exact tmux', profile: 'shell',
      providerSessionName: null, customCommand: null, backend: 'tmux', tmuxName: 'Exact tmux', dangerousMode: false })
    store.setSessionState(chosen.id, 'completed')
    const internals = manager as unknown as { killTmuxSession(connection: Connection, name: string): Promise<void> }
    const stopped = vi.spyOn(internals, 'killTmuxSession').mockRejectedValueOnce(Error('SSH host offline'))
    await expect(manager.archive(chosen.id)).rejects.toThrow('SSH host offline')
    expect(store.getSession(chosen.id)?.archived).toBe(false)
    let release!: () => void
    stopped.mockImplementationOnce(() => new Promise<void>((done) => { release = done }))
    const archiving = manager.archive(chosen.id)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(store.getSession(chosen.id)?.archived).toBe(false)
    release(); await archiving
    expect(stopped).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'local' }), 'Exact tmux')
    expect(store.getSession(chosen.id)?.archived).toBe(true)
  })

  it('does not let a stale discovery snapshot undo Archive; explicit Restore is idempotent', async () => {
    const { store, manager, project, session } = fixture()
    const chosen = session('Snapshot terminal')
    await Promise.all([manager.archive(chosen.id), manager.archive(chosen.id)])
    const metadata: PanePilotTmuxMetadata = { terminalId: chosen.id, originProjectId: project.id, projectPath: project.folder,
      profile: 'shell', sessionKind: 'terminal', providerSessionId: null, providerSessionName: null,
      dangerousMode: false, createdAt: chosen.createdAt, action: null, latex: null }
    expect(store.upsertDiscoveredTmuxSession(project.id, chosen.name, metadata)).toBeNull()
    expect(store.getSession(chosen.id)?.archived).toBe(true)
    await Promise.all([manager.restore(chosen.id), manager.restore(chosen.id)])
    expect(store.getSession(chosen.id)).toMatchObject({ archived: false, state: 'completed' })
    expect(store.getProject(project.id)?.activities.filter((event) => event.kind === 'terminal-archived')).toHaveLength(1)
  })
})
