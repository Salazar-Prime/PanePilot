import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationIndexer } from '../src/main/conversation-indexer'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { Store } from '../src/main/store'
import { TerminalManager } from '../src/main/terminal-manager'

describe('terminal tmux reconnect', () => {
  let appDataPath: string | null = null

  afterEach(() => {
    if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
    appDataPath = null
  })

  it.skipIf(spawnSync('tmux', ['-V']).status !== 0)(
    'replaces the PanePilot client while preserving the exact tmux session',
    async () => {
      appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-reconnect-'))
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
      const manager = new TerminalManager(
        store,
        () => null,
        new ConversationIndexer(),
        new RemoteConversationIndexer()
      )
      const name = `Reconnect ${randomUUID()}`
      const session = manager.start({
        projectId: project.id,
        name,
        profile: 'shell',
        dangerousMode: false
      })

      try {
        let tmuxId = ''
        for (let attempt = 0; attempt < 50 && !tmuxId; attempt += 1) {
          tmuxId =
            spawnSync(
              'tmux',
              ['display-message', '-p', '-t', `=${name}:`, '#{session_id}'],
              { encoding: 'utf8' }
            ).stdout?.trim() ?? ''
          if (!tmuxId) {
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
        }
        expect(tmuxId).not.toBe('')

        await manager.retryAttach(session.id, 100, 30)

        expect(
          spawnSync(
            'tmux',
            ['display-message', '-p', '-t', `=${name}:`, '#{session_id}'],
            { encoding: 'utf8' }
          ).stdout.trim()
        ).toBe(tmuxId)

        store.setSessionState(
          session.id,
          'completed',
          `${session.name} is no longer running in tmux.`
        )
        await manager.retryAttach(session.id, 100, 30)

        expect(store.getSession(session.id)?.state).toBe('idle')
        expect(
          spawnSync(
            'tmux',
            ['display-message', '-p', '-t', `=${name}:`, '#{session_id}'],
            { encoding: 'utf8' }
          ).stdout.trim()
        ).toBe(tmuxId)
      } finally {
        if (store.getSession(session.id)) manager.delete(session.id)
        manager.shutdown()
        store.close()
      }
    }
  )
})
