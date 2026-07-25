import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationIndexer } from '../src/main/conversation-indexer'
import { ProjectMetadataService } from '../src/main/project-metadata-service'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { Store } from '../src/main/store'
import { TerminalManager } from '../src/main/terminal-manager'

describe('project actions and Q&A persistence', () => {
  let appDataPath: string | null = null

  afterEach(() => {
    if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
    appDataPath = null
  })

  function createStoreAndProject() {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-actions-'))
    const store = new Store(appDataPath)
    store.syncConnections([])
    const projectFolder = join(appDataPath, 'project')
    mkdirSync(projectFolder)
    const project = store.createProject({
      type: 'terminal',
      name: 'Project',
      connectionId: 'local',
      folder: projectFolder,
      repositoryUrl: null
    })
    return { store, project }
  }

  it('keeps an editable action definition linked to only its latest run', () => {
    const { store, project } = createStoreAndProject()
    try {
      const action = store.createProjectAction({
        projectId: project.id,
        name: 'Run tests',
        command: 'npm test'
      })
      const run = store.createSession({
        projectId: project.id,
        kind: 'action',
        name: 'Action · Run tests',
        profile: 'custom',
        providerSessionName: null,
        customCommand: action.command,
        backend: 'tmux',
        tmuxName: 'Action · Run tests',
        dangerousMode: false
      })
      store.setProjectActionSession(action.id, run.id)
      store.appendOutput(run.id, 'all tests passed\r\n')

      expect(store.getProject(project.id)?.actions).toEqual([
        expect.objectContaining({
          id: action.id,
          name: 'Run tests',
          command: 'npm test',
          lastSessionId: run.id
        })
      ])
      expect(store.getActionForSession(run.id)?.id).toBe(action.id)

      const updated = store.updateProjectAction(action.id, {
        name: 'Check project',
        command: 'npm test && npm run typecheck'
      })
      expect(updated).toMatchObject({
        name: 'Check project',
        command: 'npm test && npm run typecheck'
      })

      store.setSessionState(run.id, 'completed')
      store.deleteSession(run.id)
      expect(store.getProjectAction(action.id)?.lastSessionId).toBeNull()
    } finally {
      store.close()
    }
  })

  it('shares Action definitions through .panepilot/actions.json', () => {
    const { store, project } = createStoreAndProject()
    const metadata = new ProjectMetadataService(store)
    try {
      const action = metadata.createAction({
        projectId: project.id,
        name: 'Run tests',
        command: 'npm test'
      })
      const actionsPath = join(
        project.folder,
        '.panepilot',
        'actions.json'
      )
      expect(JSON.parse(readFileSync(actionsPath, 'utf8'))).toEqual({
        version: 1,
        actions: [
          {
            id: action.id,
            name: 'Run tests',
            command: 'npm test'
          }
        ]
      })

      const importedId = randomUUID()
      writeFileSync(
        actionsPath,
        `${JSON.stringify(
          {
            version: 1,
            actions: [
              {
                id: action.id,
                name: 'Check project',
                command: 'npm run typecheck'
              },
              {
                id: importedId,
                name: 'Build app',
                command: 'npm run build'
              }
            ]
          },
          null,
          2
        )}\n`
      )

      expect(metadata.syncActions(project.id)).toEqual([
        expect.objectContaining({
          id: action.id,
          name: 'Check project',
          command: 'npm run typecheck'
        }),
        expect.objectContaining({
          id: importedId,
          name: 'Build app',
          command: 'npm run build'
        })
      ])
    } finally {
      store.close()
    }
  })

  it('enforces one project Q&A terminal while keeping it out of Actions', () => {
    const { store, project } = createStoreAndProject()
    try {
      const qna = store.createSession({
        projectId: project.id,
        kind: 'project-qna',
        name: 'Q&A · Project',
        profile: 'codex',
        providerSessionName: null,
        customCommand: null,
        backend: 'tmux',
        tmuxName: 'Q&A · Project',
        dangerousMode: false
      })
      expect(store.getProjectQnaSession(project.id)?.id).toBe(qna.id)
      expect(store.getProject(project.id)?.actions).toEqual([])
      expect(() =>
        store.createSession({
          projectId: project.id,
          kind: 'project-qna',
          name: 'Second Q&A',
          profile: 'codex',
          providerSessionName: null,
          customCommand: null,
          backend: 'tmux',
          tmuxName: 'Second Q&A',
          dangerousMode: false
        })
      ).toThrow()
    } finally {
      store.close()
    }
  })

  it('resets a stopped project Q&A attachment without touching provider archives', () => {
    const { store, project } = createStoreAndProject()
    const manager = new TerminalManager(
      store,
      () => null,
      new ConversationIndexer(),
      new RemoteConversationIndexer()
    )
    try {
      const qna = store.createSession({
        projectId: project.id,
        kind: 'project-qna',
        name: 'Q&A · Project',
        profile: 'codex',
        providerSessionName: null,
        customCommand: null,
        backend: 'pty',
        tmuxName: null,
        dangerousMode: false
      })
      store.setSessionState(qna.id, 'error')

      manager.resetProjectQna(project.id)

      expect(store.getProjectQnaSession(project.id)).toBeNull()
      expect(store.getSession(qna.id)).toBeNull()
    } finally {
      manager.shutdown()
      store.close()
    }
  })

  it('migrates legacy custom terminals into editable Actions', () => {
    const { store, project } = createStoreAndProject()
    const legacy = store.createSession({
      projectId: project.id,
      name: 'Build docs',
      profile: 'custom',
      providerSessionName: null,
      customCommand: 'npm --prefix docs run build',
      backend: 'tmux',
      tmuxName: 'Build docs',
      dangerousMode: false
    })
    store.close()

    const databasePath = join(appDataPath!, 'project-console.sqlite')
    const database = new DatabaseSync(databasePath)
    database.exec(`
      DROP INDEX terminal_sessions_project_qna_idx;
      DROP TABLE project_actions;
      ALTER TABLE terminal_sessions DROP COLUMN session_kind;
      PRAGMA user_version = 6;
    `)
    database.close()

    const migrated = new Store(appDataPath!)
    try {
      expect(migrated.getSession(legacy.id)?.kind).toBe('action')
      expect(migrated.getProject(project.id)?.actions).toEqual([
        expect.objectContaining({
          id: legacy.id,
          name: 'Build docs',
          command: 'npm --prefix docs run build',
          lastSessionId: legacy.id
        })
      ])
    } finally {
      migrated.close()
    }
  })

  it.skipIf(spawnSync('tmux', ['-V']).status !== 0)(
    'runs an Action in an ephemeral tmux session and retains its output',
    async () => {
      const { store, project } = createStoreAndProject()
      const manager = new TerminalManager(
        store,
        () => null,
        new ConversationIndexer(),
        new RemoteConversationIndexer()
      )
      const token = `panepilot-action-${randomUUID()}`
      const action = manager.createAction({
        projectId: project.id,
        name: token,
        command: `printf '%s\\n' '${token}'`
      })
      let sessionId: string | null = null
      try {
        const session = manager.runAction(action.id)
        sessionId = session.id
        expect(session.kind).toBe('action')
        expect(session.backend).toBe('tmux')

        let completed = store.getSession(session.id)
        for (
          let attempt = 0;
          attempt < 100 &&
          completed &&
          !['completed', 'error'].includes(completed.state);
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20))
          completed = store.getSession(session.id)
        }
        expect(completed?.state, JSON.stringify(completed)).toBe('completed')
        expect(completed?.output).toContain(token)
        expect(
          spawnSync('tmux', ['has-session', '-t', `=${session.tmuxName}`]).status
        ).not.toBe(0)

        const replacement = token.replace(
          'panepilot-action',
          'panepilot-replacement'
        )
        manager.updateAction({
          actionId: action.id,
          name: replacement,
          command: `printf '%s\\n' '${replacement}'`
        })
        const rerun = manager.runAction(action.id)
        sessionId = rerun.id
        expect(store.getSession(session.id)).toBeNull()

        let rerunCompleted = store.getSession(rerun.id)
        for (
          let attempt = 0;
          attempt < 100 &&
          rerunCompleted &&
          !['completed', 'error'].includes(rerunCompleted.state);
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20))
          rerunCompleted = store.getSession(rerun.id)
        }
        expect(rerunCompleted?.state).toBe('completed')
        expect(rerunCompleted?.output).toContain(replacement)
        expect(rerunCompleted?.output).not.toContain(token)
      } finally {
        const latest = sessionId ? store.getSession(sessionId) : null
        if (latest && !['completed', 'error'].includes(latest.state)) {
          manager.stopAction(action.id)
        }
        manager.shutdown()
        store.close()
      }
    }
  )
})
