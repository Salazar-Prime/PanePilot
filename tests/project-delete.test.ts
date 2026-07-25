import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'

let appDataPath: string | null = null

afterEach(() => {
  if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
  appDataPath = null
})

describe('archived project deletion', () => {
  it('only deletes archived projects and cascades local workspace records', () => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-project-delete-'))
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
    store.createProjectAction({
      projectId: project.id,
      name: 'Check',
      command: 'npm test'
    })
    const session = store.createSession({
      projectId: project.id,
      name: 'Codex',
      profile: 'codex',
      providerSessionName: null,
      customCommand: null,
      backend: 'tmux',
      tmuxName: 'Codex',
      dangerousMode: false
    })
    store.setSessionState(session.id, 'completed')
    store.close()

    const databasePath = join(appDataPath, 'project-console.sqlite')
    const legacyDatabase = new DatabaseSync(databasePath)
    legacyDatabase.exec(`
      DROP TABLE agent_events;
      CREATE TABLE agent_events (
        id TEXT PRIMARY KEY,
        terminal_session_id TEXT NOT NULL REFERENCES terminal_sessions(id),
        provider TEXT NOT NULL,
        payload TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
    `)
    legacyDatabase
      .prepare(
        `INSERT INTO agent_events
         (id, terminal_session_id, provider, payload, received_at)
         VALUES (?, ?, 'codex', '{}', ?)`
      )
      .run(randomUUID(), session.id, new Date().toISOString())
    legacyDatabase.close()

    const migrated = new Store(appDataPath)

    try {
      expect(() => migrated.deleteProject(project.id)).toThrow(
        'Archive the project before deleting it.'
      )
      migrated.archiveProject(project.id, true)
      migrated.deleteProject(project.id)

      expect(migrated.getProject(project.id)).toBeNull()
      expect(migrated.listProjects()).toEqual([])
    } finally {
      migrated.close()
    }
  })
})
