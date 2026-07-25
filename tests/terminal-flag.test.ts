import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'

let appDataPath: string | null = null

afterEach(() => {
  if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
  appDataPath = null
})

describe('terminal flags', () => {
  it('persists a terminal flag across store restarts', () => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-terminal-flag-'))
    const folder = join(appDataPath, 'project')
    mkdirSync(folder)
    const initial = new Store(appDataPath)
    initial.syncConnections([])
    const project = initial.createProject({
      type: 'terminal',
      name: 'Project',
      connectionId: 'local',
      folder,
      repositoryUrl: null
    })
    const session = initial.createSession({
      projectId: project.id,
      name: 'Shell',
      profile: 'shell',
      providerSessionName: null,
      customCommand: null,
      backend: 'tmux',
      tmuxName: 'Shell',
      dangerousMode: false
    })

    expect(session.flagged).toBe(false)
    initial.setSessionFlagged(session.id, true)
    initial.close()

    const reopened = new Store(appDataPath)
    try {
      expect(reopened.getSession(session.id)?.flagged).toBe(true)
      reopened.setSessionFlagged(session.id, false)
      expect(reopened.getSession(session.id)?.flagged).toBe(false)
    } finally {
      reopened.close()
    }
  })
})
