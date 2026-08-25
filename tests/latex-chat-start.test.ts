import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationIndexer } from '../src/main/conversation-indexer'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { Store } from '../src/main/store'
import { TerminalManager } from '../src/main/terminal-manager'

describe('LaTeX chat launch metadata', () => {
  let appDataPath: string | null = null

  afterEach(() => {
    if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
    appDataPath = null
  })

  it('attaches the writing scope before the first tmux launch', () => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-latex-chat-start-'))
    const store = new Store(appDataPath)
    store.syncConnections([])
    const project = store.createProject({
      type: 'latex',
      name: 'Paper',
      connectionId: 'local',
      folder: appDataPath,
      repositoryUrl: null,
      latex: {
        mainFile: 'main.tex',
        overleafUrl: null,
        contextFolder: 'context'
      }
    })
    const [section] = store.syncLatexSections(project.id, [
      {
        title: 'Results',
        level: 2,
        sourceFile: 'sections/results.tex',
        startLine: 1,
        endLine: 20,
        ordinal: 0
      }
    ])
    const manager = new TerminalManager(
      store,
      () => null,
      new ConversationIndexer(),
      new RemoteConversationIndexer()
    )
    vi.spyOn(manager as never, 'connectionHasTmux' as never).mockReturnValue(true)
    vi.spyOn(manager as never, 'tmuxSessionExists' as never).mockReturnValue(false)
    let launchedSession = null
    vi.spyOn(manager as never, 'launch' as never).mockImplementation(
      ((session: unknown) => {
        launchedSession = session
      }) as never
    )

    try {
      const session = manager.startLatexChat(
        {
          projectId: project.id,
          profile: 'codex',
          dangerousMode: false
        },
        {
          scope: 'section',
          sectionId: section.id,
          mode: 'edit'
        }
      )

      expect(session).toMatchObject({
        kind: 'latex-chat',
        latexChat: {
          scope: 'section',
          sectionId: section.id,
          mode: 'edit'
        }
      })
      expect(launchedSession).toMatchObject({
        kind: 'latex-chat',
        latexChat: {
          scope: 'section',
          sectionId: section.id,
          mode: 'edit'
        }
      })
    } finally {
      manager.shutdown()
      store.close()
    }
  })

  it('creates and reuses one hidden persistent inline Codex session', async () => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-latex-inline-start-'))
    const store = new Store(appDataPath)
    store.syncConnections([])
    const project = store.createProject({
      type: 'latex',
      name: 'Paper',
      connectionId: 'local',
      folder: appDataPath,
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
    vi.spyOn(manager as never, 'connectionHasTmux' as never).mockReturnValue(true)
    vi.spyOn(manager as never, 'tmuxSessionExists' as never).mockReturnValue(false)
    vi.spyOn(manager as never, 'launch' as never).mockImplementation(() => undefined)

    try {
      const first = await manager.startLatexInlineChat(project.id)
      const second = await manager.startLatexInlineChat(project.id)

      expect(second.id).toBe(first.id)
      expect(store.getProject(project.id)?.sessions).toHaveLength(1)
      expect(second).toMatchObject({
        profile: 'codex',
        kind: 'latex-chat',
        backend: 'tmux',
        latexChat: {
          purpose: 'inline-edit',
          scope: 'project',
          sectionId: null,
          mode: 'edit'
        }
      })
    } finally {
      manager.shutdown()
      store.close()
    }
  })
})
