import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'

describe('temporary Codex chat storage', () => {
  let appDataPath: string | null = null

  afterEach(() => {
    if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
    appDataPath = null
  })

  it('widens an existing terminal kind constraint without losing references', () => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-temporary-chat-migration-'))
    const databasePath = join(appDataPath, 'project-console.sqlite')
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('local', 'ssh')),
        name TEXT NOT NULL,
        ssh_alias TEXT
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'terminal',
        name TEXT NOT NULL,
        icon TEXT,
        connection_id TEXT NOT NULL REFERENCES connections(id),
        folder TEXT NOT NULL,
        repository_url TEXT,
        state TEXT NOT NULL DEFAULT 'idle',
        archived INTEGER NOT NULL DEFAULT 0,
        parent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE terminal_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_kind TEXT NOT NULL DEFAULT 'terminal'
          CHECK (session_kind IN ('terminal', 'action', 'project-qna', 'latex-chat')),
        name TEXT NOT NULL,
        profile TEXT NOT NULL,
        provider_session_id TEXT,
        provider_session_name TEXT,
        custom_command TEXT,
        backend TEXT NOT NULL,
        tmux_name TEXT,
        state TEXT NOT NULL DEFAULT 'idle',
        dangerous_mode INTEGER NOT NULL DEFAULT 0,
        tmux_metadata_version INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        flagged INTEGER NOT NULL DEFAULT 0,
        output TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO connections (id, kind, name, ssh_alias)
      VALUES ('local', 'local', 'This Mac', NULL);
      INSERT INTO projects
        (id, type, name, icon, connection_id, folder, repository_url, state,
         archived, parent_id, created_at, updated_at)
      VALUES
        ('11111111-1111-4111-8111-111111111111', 'terminal', 'Existing project',
         NULL, 'local', '/tmp/existing-project', NULL, 'idle', 0, NULL,
         '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
      INSERT INTO terminal_sessions
        (id, project_id, session_kind, name, profile, provider_session_id,
         provider_session_name, custom_command, backend, tmux_name, state,
         dangerous_mode, tmux_metadata_version, archived, pinned, flagged,
         output, created_at, updated_at)
      VALUES
        ('550e8400-e29b-41d4-a716-446655440000',
         '11111111-1111-4111-8111-111111111111', 'terminal', 'Existing shell',
         'shell', NULL, NULL, NULL, 'tmux', 'Existing shell', 'idle', 0, 1,
         0, 0, 0, '', '2026-08-01T00:00:00.000Z',
         '2026-08-01T00:00:00.000Z');
      PRAGMA user_version = 13;
    `)
    legacy.close()

    const store = new Store(appDataPath)
    try {
      store.syncConnections([])
      expect(
        store.getSession('550e8400-e29b-41d4-a716-446655440000')
      ).toMatchObject({
        name: 'Existing shell',
        kind: 'terminal'
      })
      const project = store.createProject({
        type: 'terminal',
        name: 'Migrated project',
        connectionId: 'local',
        folder: '/tmp/migrated-project',
        repositoryUrl: null
      })
      const session = store.createSession({
        projectId: project.id,
        kind: 'temporary-chat',
        name: 'Quick chat 1',
        profile: 'codex',
        providerSessionName: null,
        customCommand: null,
        backend: 'tmux',
        tmuxName: 'Quick chat 1',
        dangerousMode: false
      })

      expect(store.getSession(session.id)?.kind).toBe('temporary-chat')
      const database = (store as unknown as { db: DatabaseSync }).db
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(
        (
          database
            .prepare(
              `SELECT sql FROM sqlite_master
               WHERE type = 'table' AND name = 'terminal_sessions'`
            )
            .get() as { sql: string }
        ).sql
      ).toContain("'temporary-chat'")
    } finally {
      store.close()
    }
  })
})
