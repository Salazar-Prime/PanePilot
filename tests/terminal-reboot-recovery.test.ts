import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationIndexer } from '../src/main/conversation-indexer'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { Store } from '../src/main/store'
import {
  sessionPredatesSystemBoot,
  systemBootTimeMs,
  TerminalManager
} from '../src/main/terminal-manager'

describe('terminal reboot recovery', () => {
  let appDataPath: string | null = null

  afterEach(() => {
    if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
    appDataPath = null
  })

  it('recognizes only session records from before the current boot', () => {
    const bootTime = Date.parse('2026-08-02T12:00:00.000Z')

    expect(systemBootTimeMs(bootTime + 60_000, 60)).toBe(bootTime)
    expect(
      sessionPredatesSystemBoot('2026-08-02T11:59:00.000Z', bootTime)
    ).toBe(true)
    expect(
      sessionPredatesSystemBoot('2026-08-02T12:00:10.000Z', bootTime)
    ).toBe(false)
    expect(sessionPredatesSystemBoot('not-a-date', bootTime)).toBe(false)
  })

  it.skipIf(spawnSync('tmux', ['-V']).status !== 0)(
    'recreates safe local sessions while leaving Actions and dangerous agents stopped',
    async () => {
      appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-reboot-recovery-'))
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
      const shellName = `Reboot shell ${randomUUID()}`
      const actionName = `Reboot action ${randomUUID()}`
      const dangerousName = `Reboot unsafe ${randomUUID()}`
      const shell = store.createSession({
        projectId: project.id,
        name: shellName,
        profile: 'shell',
        providerSessionName: null,
        customCommand: null,
        backend: 'tmux',
        tmuxName: shellName,
        dangerousMode: false
      })
      const action = store.createSession({
        projectId: project.id,
        kind: 'action',
        name: actionName,
        profile: 'custom',
        providerSessionName: null,
        customCommand: 'printf restored-incorrectly',
        backend: 'tmux',
        tmuxName: actionName,
        dangerousMode: false
      })
      const dangerousAgent = store.createSession({
        projectId: project.id,
        name: dangerousName,
        profile: 'codex',
        providerSessionName: null,
        customCommand: null,
        backend: 'tmux',
        tmuxName: dangerousName,
        dangerousMode: true
      })
      const manager = new TerminalManager(
        store,
        () => null,
        new ConversationIndexer(),
        new RemoteConversationIndexer()
      )

      try {
        const restored = manager.restoreLocalSessionsAfterReboot(
          Date.now() + 60_000
        )
        expect(restored).toBe(1)

        let owner = ''
        for (let attempt = 0; attempt < 50 && !owner; attempt += 1) {
          owner = spawnSync(
            'tmux',
            [
              'show-options',
              '-qv',
              '-t',
              `=${shellName}:`,
              '@panepilot_terminal_id'
            ],
            { encoding: 'utf8' }
          ).stdout.trim()
          if (!owner) await new Promise((resolve) => setTimeout(resolve, 20))
        }

        expect(owner).toBe(shell.id)
        expect(store.getSession(shell.id)?.state).toBe('idle')
        expect(store.getSession(action.id)?.state).toBe('completed')
        expect(store.getSession(dangerousAgent.id)?.state).toBe('completed')
        expect(
          spawnSync('tmux', ['has-session', '-t', `=${actionName}`]).status
        ).not.toBe(0)
        expect(
          spawnSync('tmux', ['has-session', '-t', `=${dangerousName}`]).status
        ).not.toBe(0)
        expect(
          store
            .getProject(project.id)
            ?.activities.some(
              (activity) =>
                activity.sessionId === shell.id &&
                activity.kind === 'terminal-reboot-restored'
            )
        ).toBe(true)
      } finally {
        for (const session of [shell, action, dangerousAgent]) {
          if (store.getSession(session.id)) manager.delete(session.id)
        }
        manager.shutdown()
        store.close()
      }
    }
  )
})
