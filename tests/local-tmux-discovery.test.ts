import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationIndexer } from '../src/main/conversation-indexer'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { Store } from '../src/main/store'
import { TerminalManager } from '../src/main/terminal-manager'
import type { Connection } from '../src/shared/types'
import type {
  ListedTmuxSession,
  PanePilotTmuxMetadata
} from '../src/main/tmux-metadata'

const FOREIGN_PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const TERMINAL_ID = '22222222-2222-4222-8222-222222222222'
const LATEX_CHAT_ID = '33333333-3333-4333-8333-333333333333'
const PROJECT_QNA_ID = '44444444-4444-4444-8444-444444444444'

function listedSession(
  name: string,
  metadata: PanePilotTmuxMetadata
): ListedTmuxSession {
  return {
    tmuxId: `$${metadata.terminalId.slice(0, 2)}`,
    name,
    attachedClients: 0,
    paneTitle: 'Ready',
    paneCurrentCommand: 'codex',
    paneDead: false,
    metadata
  }
}

function metadata(
  terminalId: string,
  projectPath: string,
  overrides: Partial<PanePilotTmuxMetadata> = {}
): PanePilotTmuxMetadata {
  return {
    terminalId,
    originProjectId: FOREIGN_PROJECT_ID,
    projectPath,
    profile: 'codex',
    providerSessionId: `provider-${terminalId}`,
    providerSessionName: null,
    createdAt: '2026-08-24T12:00:00.000Z',
    dangerousMode: false,
    sessionKind: 'terminal',
    action: null,
    latex: null,
    ...overrides
  }
}

describe('local tmux discovery', () => {
  let appDataPath: string | null = null

  afterEach(() => {
    if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
    appDataPath = null
  })

  it('imports sessions created over SSH into same-path local projects', async () => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-local-discovery-'))
    const store = new Store(appDataPath)
    store.syncConnections([])
    const terminalFolder = join(appDataPath, 'ved-scout')
    const latexFolder = join(appDataPath, 'evaluating-llm-reliability')
    mkdirSync(terminalFolder)
    mkdirSync(latexFolder)
    const terminalProject = store.createProject({
      type: 'terminal',
      name: 'Ved Scout',
      connectionId: 'local',
      folder: terminalFolder,
      repositoryUrl: null
    })
    const latexProject = store.createProject({
      type: 'latex',
      name: 'Evaluating LLM Reliability',
      connectionId: 'local',
      folder: latexFolder,
      repositoryUrl: null,
      latex: {
        mainFile: 'main.tex',
        overleafUrl: null,
        contextFolder: 'context'
      }
    })
    const manager = new TerminalManager(
      store,
      () => null,
      new ConversationIndexer(),
      new RemoteConversationIndexer()
    )
    const sessions = [
      listedSession(
        'Manuscript Fig - safety',
        metadata(TERMINAL_ID, terminalFolder)
      ),
      listedSession(
        'Add Halow Details',
        metadata(LATEX_CHAT_ID, latexFolder, {
          sessionKind: 'latex-chat',
          latex: {
            scope: 'project',
            mode: 'edit',
            sectionId: null,
            sectionSource: null,
            sectionTitle: null,
            sectionLevel: null
          }
        })
      ),
      listedSession(
        'Q&A · Evaluating LLM Reliability',
        metadata(PROJECT_QNA_ID, latexFolder, {
          sessionKind: 'project-qna'
        })
      )
    ]
    const internals = manager as unknown as {
      listTmuxSessions(
        connection: Connection
      ): Promise<ListedTmuxSession[] | null>
    }
    vi.spyOn(internals, 'listTmuxSessions').mockResolvedValue(sessions)

    try {
      expect(await manager.reconcileSessions('local')).toBe(3)
      expect(store.getSession(TERMINAL_ID)).toMatchObject({
        projectId: terminalProject.id,
        name: 'Manuscript Fig - safety'
      })
      expect(store.getSession(LATEX_CHAT_ID)).toMatchObject({
        projectId: latexProject.id,
        kind: 'latex-chat',
        latexChat: {
          scope: 'project',
          mode: 'edit'
        }
      })
      expect(store.getProjectQnaSession(latexProject.id)).toMatchObject({
        id: PROJECT_QNA_ID,
        kind: 'project-qna'
      })
      expect(await manager.reconcileSessions('local')).toBe(0)
    } finally {
      manager.shutdown()
      store.close()
    }
  })
})
