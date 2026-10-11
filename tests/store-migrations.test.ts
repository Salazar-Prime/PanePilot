import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'

describe('retired feature storage migrations', () => {
  let appDataPath: string

  beforeEach(() => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-store-migrations-'))
  })

  afterEach(() => {
    rmSync(appDataPath, { recursive: true, force: true })
  })

  function expectCurrentSchema(): void {
    const database = new DatabaseSync(join(appDataPath, 'project-console.sqlite'))
    try {
      expect(database.prepare('PRAGMA user_version').get()).toMatchObject({
        user_version: 21
      })
      expect(database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('speech_settings', 'speech_usage')
      `).all()).toEqual([])
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      database.close()
    }
  }

  it('initializes new workspaces without speech tables and reopens them', () => {
    for (let pass = 0; pass < 2; pass += 1) {
      const store = new Store(appDataPath)
      store.close()
      expectCurrentSchema()
    }
  })

  it('adds durable reboot recovery to version 20 without changing saved terminals', () => {
    const original = new Store(appDataPath)
    original.syncConnections([])
    const project = original.createProject({ type: 'terminal', name: 'Project',
      connectionId: 'local', folder: appDataPath, repositoryUrl: null })
    const session = original.createSession({ projectId: project.id,
      name: 'Saved terminal', profile: 'shell', backend: 'tmux', tmuxName: 'Saved terminal',
      providerSessionName: null, customCommand: null, dangerousMode: false })
    original.replaceOutput(session.id, 'Preserved output')
    original.close()
    const legacy = new DatabaseSync(join(appDataPath, 'project-console.sqlite'))
    legacy.exec('ALTER TABLE terminal_sessions DROP COLUMN reboot_recovery_pending; PRAGMA user_version = 20;')
    legacy.close()
    const migrated = new Store(appDataPath)
    try {
      expect(migrated.isSessionPendingRebootRecovery(session.id)).toBe(false)
      expect(migrated.getSession(session.id)).toMatchObject({
        id: session.id, name: session.name, state: 'idle', output: 'Preserved output'
      })
      migrated.deferSessionForRebootRecovery(session.id)
      expect(migrated.isSessionPendingRebootRecovery(session.id)).toBe(true)
    } finally {
      migrated.close()
    }
    expectCurrentSchema()
  })

  it('removes legacy speech data while preserving projects, actions, and terminal output', () => {
    const original = new Store(appDataPath)
    let projectId: string
    let sessionId: string
    try {
      original.syncConnections([])
      const project = original.createProject({
        type: 'terminal',
        name: 'Existing project',
        connectionId: 'local',
        folder: appDataPath,
        repositoryUrl: null
      })
      projectId = project.id
      sessionId = original.createSession({
        projectId,
        name: 'Existing shell',
        profile: 'shell',
        providerSessionName: null,
        customCommand: null,
        backend: 'tmux',
        tmuxName: 'Existing-shell',
        dangerousMode: false
      }).id
      original.replaceOutput(sessionId, 'Saved terminal output\r\n')
      original.createProjectAction({ projectId, name: 'Check', command: 'npm test' })
    } finally {
      original.close()
    }

    const legacy = new DatabaseSync(join(appDataPath, 'project-console.sqlite'))
    try {
      legacy.exec(`
        CREATE TABLE speech_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          provider TEXT NOT NULL DEFAULT 'google-neural2'
            CHECK (provider = 'google-neural2'),
          voice_name TEXT NOT NULL DEFAULT 'en-US-Neural2-F',
          language_code TEXT NOT NULL DEFAULT 'en-US',
          speaking_rate REAL NOT NULL DEFAULT 1,
          pitch REAL NOT NULL DEFAULT 0,
          monthly_character_limit INTEGER NOT NULL DEFAULT 950000,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE speech_usage (
          billing_month TEXT PRIMARY KEY,
          characters INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
        INSERT INTO speech_settings (id, updated_at) VALUES (1, datetime('now'));
        INSERT INTO speech_usage VALUES ('2026-10', 1200, datetime('now'));
        PRAGMA user_version = 17;
      `)
    } finally {
      legacy.close()
    }

    for (let pass = 0; pass < 2; pass += 1) {
      const migrated = new Store(appDataPath)
      try {
        expect(migrated.getProject(projectId)).toMatchObject({
          name: 'Existing project',
          connectionId: 'local',
          folder: appDataPath
        })
        expect(migrated.getSession(sessionId)).toMatchObject({
          projectId,
          name: 'Existing shell',
          tmuxName: 'Existing-shell',
          output: 'Saved terminal output\r\n'
        })
        expect(migrated.getProject(projectId)?.actions).toEqual([
          expect.objectContaining({ name: 'Check', command: 'npm test' })
        ])
      } finally {
        migrated.close()
      }
      expectCurrentSchema()
    }
  })

  it('deletes only archived terminal records and output, not archived projects', () => {
    const original = new Store(appDataPath)
    original.syncConnections([])
    const project = original.createProject({
      type: 'terminal', name: 'Preserved project', connectionId: 'local',
      folder: appDataPath, repositoryUrl: null
    })
    const archived = original.createSession({
      projectId: project.id, name: 'Old terminal', profile: 'shell',
      providerSessionName: null, customCommand: null, backend: 'pty',
      tmuxName: null, dangerousMode: false
    })
    const retained = original.createSession({
      projectId: project.id, name: 'Kept terminal', profile: 'shell',
      providerSessionName: null, customCommand: null, backend: 'pty',
      tmuxName: null, dangerousMode: false
    })
    original.replaceOutput(archived.id, 'Archived output')
    original.replaceOutput(retained.id, 'Kept output')
    original.close()

    const legacy = new DatabaseSync(join(appDataPath, 'project-console.sqlite'))
    legacy.prepare('UPDATE terminal_sessions SET archived = 1 WHERE id = ?').run(archived.id)
    legacy.prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(project.id)
    legacy.exec('PRAGMA user_version = 19')
    legacy.close()

    const migrated = new Store(appDataPath)
    try {
      expect(migrated.getSession(archived.id)).toBeNull()
      expect(migrated.getSession(retained.id)?.output).toBe('Kept output')
      expect(migrated.getProject(project.id)?.archived).toBe(true)
    } finally {
      migrated.close()
    }
    expectCurrentSchema()
  })
})
