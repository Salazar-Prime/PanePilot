import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'

describe('terminal session transfer', () => {
  let appDataPath: string | null = null

  afterEach(() => {
    if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
    appDataPath = null
  })

  it('moves an ordinary session between projects on one machine', () => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-terminal-transfer-'))
    const store = new Store(appDataPath)
    try {
      store.syncConnections([])
      const source = store.createProject({
        type: 'terminal',
        name: 'Source',
        connectionId: 'local',
        folder: '/tmp/source',
        repositoryUrl: null
      })
      const destination = store.createProject({
        type: 'terminal',
        name: 'Destination',
        connectionId: 'local',
        folder: '/tmp/destination',
        repositoryUrl: null
      })
      const session = store.createSession({
        projectId: source.id,
        kind: 'terminal',
        name: 'Codex 1',
        profile: 'codex',
        providerSessionName: null,
        customCommand: null,
        backend: 'tmux',
        tmuxName: 'Codex 1',
        dangerousMode: false
      })
      store.setSessionPinned(session.id, true)
      store.setSessionState(session.id, 'running')

      expect(store.transferSession(session.id, destination.id)).toMatchObject({
        id: session.id,
        projectId: destination.id,
        pinned: false,
        state: 'running'
      })
      expect(store.getProject(source.id)?.sessions).toHaveLength(0)
      expect(store.getProject(source.id)?.state).toBe('idle')
      expect(store.getProject(destination.id)?.state).toBe('running')
      expect(
        store
          .getProject(source.id)
          ?.activities.some((activity) => activity.kind === 'terminal-transferred-out')
      ).toBe(true)
      expect(
        store
          .getProject(destination.id)
          ?.activities.some((activity) => activity.kind === 'terminal-transferred-in')
      ).toBe(true)
    } finally {
      store.close()
    }
  })

  it('rejects cross-machine and capability-owned session transfers', () => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-terminal-transfer-rules-'))
    const store = new Store(appDataPath)
    try {
      store.syncConnections(['remote'])
      const local = store.createProject({
        type: 'terminal',
        name: 'Local',
        connectionId: 'local',
        folder: '/tmp/local',
        repositoryUrl: null
      })
      const remote = store.createProject({
        type: 'terminal',
        name: 'Remote',
        connectionId: 'ssh:remote',
        folder: '/srv/remote',
        repositoryUrl: null
      })
      const terminal = store.createSession({
        projectId: local.id,
        name: 'Shell 1',
        profile: 'shell',
        providerSessionName: null,
        customCommand: null,
        backend: 'pty',
        tmuxName: null,
        dangerousMode: false
      })
      const quickChat = store.createSession({
        projectId: local.id,
        kind: 'temporary-chat',
        name: 'Quick chat 1',
        profile: 'codex',
        providerSessionName: null,
        customCommand: null,
        backend: 'tmux',
        tmuxName: 'Quick chat 1',
        dangerousMode: false
      })

      expect(() => store.transferSession(terminal.id, remote.id)).toThrow(
        'same machine'
      )
      expect(() => store.transferSession(quickChat.id, remote.id)).toThrow(
        'ordinary terminal'
      )
    } finally {
      store.close()
    }
  })
})
