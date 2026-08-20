import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationIndexer } from '../src/main/conversation-indexer'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { Store } from '../src/main/store'
import { TerminalManager } from '../src/main/terminal-manager'
import type { TerminalSessionKind } from '../src/shared/types'

describe('project archiving', () => {
  let appDataPath: string | null = null

  afterEach(() => {
    if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
    appDataPath = null
  })

  it('stops active terminal and capability sessions before archiving', () => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-project-archive-'))
    const store = new Store(appDataPath)
    store.syncConnections([])
    const folder = join(appDataPath, 'project')
    mkdirSync(folder)
    const project = store.createProject({
      type: 'terminal',
      name: 'Project',
      connectionId: 'local',
      folder,
      repositoryUrl: null
    })
    const kinds: TerminalSessionKind[] = [
      'terminal',
      'action',
      'project-qna',
      'temporary-chat',
      'latex-chat'
    ]
    const sessions = kinds.map((kind) =>
      store.createSession({
        projectId: project.id,
        kind,
        name: `Session ${kind}`,
        profile: kind === 'action' ? 'custom' : 'codex',
        providerSessionName: null,
        customCommand: kind === 'action' ? 'true' : null,
        backend: 'pty',
        tmuxName: null,
        dangerousMode: false
      })
    )
    const manager = new TerminalManager(
      store,
      () => null,
      new ConversationIndexer(),
      new RemoteConversationIndexer()
    )

    try {
      expect(() => store.archiveProject(project.id, true)).toThrow(
        'Stop every running terminal or chat before archiving this project.'
      )

      manager.archiveProject(project.id)

      expect(store.getProject(project.id)?.archived).toBe(true)
      expect(sessions.map((session) => store.getSession(session.id)?.state)).toEqual(
        kinds.map(() => 'completed')
      )
    } finally {
      manager.shutdown()
      store.close()
    }
  })
})
