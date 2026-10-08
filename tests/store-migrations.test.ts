import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'

describe('retired speech storage migration', () => {
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
        user_version: 18
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
})
