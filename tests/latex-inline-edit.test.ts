import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extractLatexSelection,
  LatexProjectService
} from '../src/main/latex-project-service'
import { Store } from '../src/main/store'
import type { TerminalManager } from '../src/main/terminal-manager'
import {
  latexChatCoversSelection,
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
    expect(
      latexChatCoversSelection(
        {
          id: 'chat',
          projectId: 'project',
          kind: 'latex-chat',
          name: 'method-edit',
          profile: 'codex',
          providerSessionId: null,
          providerSessionName: null,
          customCommand: null,
          backend: 'tmux',
          tmuxName: 'method-edit',
          state: 'idle',
          dangerousMode: false,
          archived: false,
          pinned: false,
          flagged: false,
          output: '',
          latexChat: {
            terminalSessionId: 'chat',
            projectId: 'project',
            scope: 'section',
            sectionId: 'section',
            mode: 'ask',
            createdAt: '2026-08-25T00:00:00.000Z'
          },
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z'
        },
        [section],
        selection
      )
    ).toBe(true)
  })
})

describe('LaTeX inline edit dispatch', () => {
  let appDataPath: string | null = null

  afterEach(() => {
    if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
    appDataPath = null
  })

  it('switches the compatible chat to Edit mode and sends the exact selection', () => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-latex-inline-edit-'))
    mkdirSync(join(appDataPath, 'context'))
    writeFileSync(
      join(appDataPath, 'main.tex'),
      '\\section{Introduction}\nA precise sentence for revision.\n'
    )
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
    const session = store.createSession({
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
    store.attachLatexChat(session.id, {
      projectId: project.id,
      scope: 'project',
      sectionId: null,
      mode: 'ask'
    })
    const terminals = {
      sendPrompt: vi.fn(),
      syncSessionMetadata: vi.fn()
    } as unknown as TerminalManager
    const service = new LatexProjectService(store, terminals)
    const selection: LatexSourceSelection = {
      path: 'main.tex',
      startLine: 2,
      startColumn: 3,
      endLine: 2,
      endColumn: 19,
      text: 'precise sentence'
    }

    try {
      service.sendInlineEdit({
        sessionId: session.id,
        selection,
        instruction: 'Make this more direct.'
      })

      expect(store.getLatexChat(session.id)?.mode).toBe('edit')
      expect(store.getLatexSnapshots(session.id)).not.toHaveLength(0)
      expect(terminals.sendPrompt).toHaveBeenCalledWith(
        session.id,
        expect.stringContaining('"selectedSource":"precise sentence"')
      )
      expect(terminals.sendPrompt).toHaveBeenCalledWith(
        session.id,
        expect.stringContaining('Make this more direct.')
      )
    } finally {
      store.close()
    }
  })

  it('refuses to send after the saved source no longer matches', () => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-latex-inline-stale-'))
    mkdirSync(join(appDataPath, 'context'))
    writeFileSync(join(appDataPath, 'main.tex'), 'Original source.\n')
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
    const session = store.createSession({
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
    store.attachLatexChat(session.id, {
      projectId: project.id,
      scope: 'project',
      sectionId: null,
      mode: 'edit'
    })
    const terminals = {
      sendPrompt: vi.fn(),
      syncSessionMetadata: vi.fn()
    } as unknown as TerminalManager
    const service = new LatexProjectService(store, terminals)

    try {
      expect(() =>
        service.sendInlineEdit({
          sessionId: session.id,
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
      ).toThrow('selected source changed')
      expect(terminals.sendPrompt).not.toHaveBeenCalled()
    } finally {
      store.close()
    }
  })
})
