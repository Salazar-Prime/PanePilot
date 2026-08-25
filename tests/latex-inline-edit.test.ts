import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationIndexer } from '../src/main/conversation-indexer'
import {
  extractLatexSelection,
  latexInlineParagraphContext,
  LatexProjectService
} from '../src/main/latex-project-service'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { Store } from '../src/main/store'
import { TerminalManager } from '../src/main/terminal-manager'
import {
  latexSectionContainsSelection,
  latexSelectionLastLine
} from '../src/shared/latex-inline-edit'
import type { LatexSourceSelection } from '../src/shared/types'

describe('LaTeX inline edit ranges', () => {
  it('extracts Monaco ranges from normalized multi-line source', () => {
    expect(
      extractLatexSelection('First\r\nSecond line\r\nThird', {
        startLine: 1,
        startColumn: 3,
        endLine: 2,
        endColumn: 7
      })
    ).toBe('rst\nSecond')
  })

  it('rejects stale or malformed source coordinates', () => {
    expect(() =>
      extractLatexSelection('Short', {
        startLine: 1,
        startColumn: 2,
        endLine: 1,
        endColumn: 20
      })
    ).toThrow('no longer matches')
    expect(() =>
      extractLatexSelection('Short', {
        startLine: 1,
        startColumn: 3,
        endLine: 1,
        endColumn: 3
      })
    ).toThrow('Select some source text')
  })

  it('treats an end column of one as an exclusive next line', () => {
    const selection = {
      path: 'main.tex',
      startLine: 3,
      startColumn: 1,
      endLine: 6,
      endColumn: 1,
      text: 'three lines\n'
    }
    const section = {
      id: 'section',
      projectId: 'project',
      title: 'Method',
      level: 2,
      sourceFile: 'main.tex',
      startLine: 3,
      endLine: 5,
      ordinal: 0
    }

    expect(latexSelectionLastLine(selection)).toBe(5)
    expect(latexSectionContainsSelection(section, selection)).toBe(true)
  })

  it('returns the selected paragraph and one paragraph on either side', () => {
    expect(
      latexInlineParagraphContext(
        [
          'Paragraph above.',
          '',
          'Selected paragraph starts.',
          'Selected paragraph continues.',
          '',
          'Paragraph below.'
        ].join('\n'),
        { startLine: 3, endLine: 3, endColumn: 9 }
      )
    ).toEqual({
      before: { startLine: 1, endLine: 1, text: 'Paragraph above.' },
      selected: {
        startLine: 3,
        endLine: 4,
        text: 'Selected paragraph starts.\nSelected paragraph continues.'
      },
      after: { startLine: 6, endLine: 6, text: 'Paragraph below.' }
    })
  })
})

describe('LaTeX inline edit dispatch', () => {
  let appDataPath: string | null = null

  afterEach(() => {
    if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
    appDataPath = null
  })

  function createInlineProject(source: string) {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-latex-inline-edit-'))
    mkdirSync(join(appDataPath, 'context'))
    writeFileSync(join(appDataPath, 'main.tex'), source)
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
    const created = store.createSession({
      projectId: project.id,
      kind: 'latex-chat',
      name: 'inline-editor',
      profile: 'codex',
      providerSessionName: null,
      customCommand: null,
      backend: 'tmux',
      tmuxName: 'inline-editor',
      dangerousMode: false
    })
    store.attachLatexChat(created.id, {
      projectId: project.id,
      purpose: 'inline-edit',
      scope: 'project',
      sectionId: null,
      mode: 'edit'
    })
    return {
      store,
      project,
      session: store.getSession(created.id)!
    }
  }

  it('reuses the hidden chat and sends exact selection with neighboring paragraphs', async () => {
    const { store, project, session } = createInlineProject(
      [
        'Paragraph above.',
        '',
        'A precise sentence for revision.',
        'It continues here.',
        '',
        'Paragraph below.'
      ].join('\n')
    )
    const terminals = {
      startLatexInlineChat: vi.fn().mockResolvedValue(session),
      clearCodexChatAndSendPrompt: vi.fn().mockResolvedValue(undefined)
    } as unknown as TerminalManager
    const service = new LatexProjectService(store, terminals)
    const selection: LatexSourceSelection = {
      path: 'main.tex',
      startLine: 3,
      startColumn: 3,
      endLine: 3,
      endColumn: 19,
      text: 'precise sentence'
    }

    try {
      await service.sendInlineEdit({
        projectId: project.id,
        selection,
        instruction: 'Make this more direct.'
      })

      expect(terminals.startLatexInlineChat).toHaveBeenCalledWith(project.id)
      expect(store.getLatexSnapshots(session.id)).not.toHaveLength(0)
      expect(terminals.clearCodexChatAndSendPrompt).toHaveBeenCalledWith(
        session.id,
        expect.stringContaining('"selectedSource":"precise sentence"')
      )
      const prompt = vi.mocked(terminals.clearCodexChatAndSendPrompt).mock
        .calls[0][1]
      expect(prompt).toContain('"text":"Paragraph above."')
      expect(prompt).toContain(
        '"text":"A precise sentence for revision.\\nIt continues here."'
      )
      expect(prompt).toContain('"text":"Paragraph below."')
      expect(prompt).toContain('Make this more direct.')
    } finally {
      store.close()
    }
  })

  it('refuses stale source before creating or clearing the hidden chat', async () => {
    const { store, project, session } = createInlineProject('Original source.\n')
    const terminals = {
      startLatexInlineChat: vi.fn().mockResolvedValue(session),
      clearCodexChatAndSendPrompt: vi.fn().mockResolvedValue(undefined)
    } as unknown as TerminalManager
    const service = new LatexProjectService(store, terminals)

    try {
      await expect(
        service.sendInlineEdit({
          projectId: project.id,
          selection: {
            path: 'main.tex',
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 9,
            text: 'Changed!'
          },
          instruction: 'Rewrite this.'
        })
      ).rejects.toThrow('selected source changed')
      expect(terminals.startLatexInlineChat).not.toHaveBeenCalled()
      expect(terminals.clearCodexChatAndSendPrompt).not.toHaveBeenCalled()
    } finally {
      store.close()
    }
  })

  it('sends Codex internal /clear before the new edit prompt', async () => {
    const { store, session } = createInlineProject('Source text.\n')
    const manager = new TerminalManager(
      store,
      () => null,
      new ConversationIndexer(),
      new RemoteConversationIndexer()
    )
    const events: string[] = []
    const output = (
      manager as unknown as {
        volatileOutput: Map<
          string,
          { chunks: string[]; byteLength: number }
        >
      }
    ).volatileOutput
    output.set(session.id, { chunks: ['Codex ready'], byteLength: 11 })
    vi.spyOn(manager, 'attach').mockReturnValue({ output: 'Codex ready' })
    vi.spyOn(manager, 'write').mockImplementation((sessionId, data) => {
      events.push(`write:${data}`)
      if (data === '/clear\r') {
        output.set(sessionId, { chunks: ['Chat cleared'], byteLength: 12 })
      }
    })
    vi.spyOn(manager, 'sendPrompt').mockImplementation((_sessionId, prompt) => {
      events.push(`prompt:${prompt}`)
    })

    try {
      await manager.clearCodexChatAndSendPrompt(session.id, 'Apply the edit.')
      expect(events).toEqual([
        'write:/clear\r',
        'prompt:Apply the edit.'
      ])
    } finally {
      manager.shutdown()
      store.close()
    }
  })

  it('enforces one hidden inline chat per LaTeX project', () => {
    const { store, project, session } = createInlineProject('Source text.\n')
    try {
      expect(store.getLatexInlineEditSession(project.id)?.id).toBe(session.id)
      expect(session.latexChat).toMatchObject({
        purpose: 'inline-edit',
        scope: 'project',
        mode: 'edit'
      })
      const duplicate = store.createSession({
        projectId: project.id,
        kind: 'latex-chat',
        name: 'duplicate-inline-editor',
        profile: 'codex',
        providerSessionName: null,
        customCommand: null,
        backend: 'tmux',
        tmuxName: 'duplicate-inline-editor',
        dangerousMode: false
      })
      expect(() =>
        store.attachLatexChat(duplicate.id, {
          projectId: project.id,
          purpose: 'inline-edit',
          scope: 'project',
          sectionId: null,
          mode: 'edit'
        })
      ).toThrow()
    } finally {
      store.close()
    }
  })
})
