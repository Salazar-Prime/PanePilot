import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationIndexer } from '../src/main/conversation-indexer'
import {
  codexExecModelOutput,
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
import {
  LATEX_INLINE_OUTPUT_END,
  LATEX_INLINE_OUTPUT_START
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

  it('extracts the final model note from codex exec JSON events', () => {
    expect(
      codexExecModelOutput(
        [
          '{"type":"thread.started","thread_id":"thread"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"Applied the concise revision."}}',
          '{"type":"turn.completed"}'
        ].join('\r\n')
      )
    ).toBe('Applied the concise revision.')
  })

  it('extracts the exact saved Codex message from a wrapped tmux marker', () => {
    const message = 'Applied the edit directly.\n\nThe selection is now concise.'
    const encoded = Buffer.from(message).toString('base64')
    expect(
      codexExecModelOutput(
        `${LATEX_INLINE_OUTPUT_START}${encoded.slice(0, 24)}\r\n` +
          `\u001b[K${encoded.slice(24)}${LATEX_INLINE_OUTPUT_END}\r\n`
      )
    ).toBe(message)
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
    const runLatexInlineEditExec = vi.fn().mockImplementation(async () => {
      writeFileSync(
        join(appDataPath!, 'main.tex'),
        [
          'Paragraph above.',
          '',
          'A clear phrase for revision.',
          'It continues here.',
          '',
          'Paragraph below.'
        ].join('\n')
      )
      return {
        exitCode: 0,
        output:
          '{"type":"item.completed","item":{"type":"agent_message","text":"Made the selected phrase more direct."}}\r\n'
      }
    })
    const terminals = {
      startLatexInlineChat: vi.fn().mockResolvedValue(session),
      runLatexInlineEditExec
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
      const edit = await service.sendInlineEdit({
        projectId: project.id,
        selection,
        instruction: 'Make this more direct.'
      })

      expect(terminals.startLatexInlineChat).toHaveBeenCalledWith(project.id)
      expect(store.getLatexSnapshots(session.id)).not.toHaveLength(0)
      expect(terminals.runLatexInlineEditExec).toHaveBeenCalledWith(
        session.id,
        expect.stringContaining('"selectedSource":"precise sentence"')
      )
      const prompt = vi.mocked(terminals.runLatexInlineEditExec).mock.calls[0][1]
      expect(prompt).toContain('"text":"Paragraph above."')
      expect(prompt).toContain(
        '"text":"A precise sentence for revision.\\nIt continues here."'
      )
      expect(prompt).toContain('"text":"Paragraph below."')
      expect(prompt).toContain('Make this more direct.')
      expect(edit).toMatchObject({
        status: 'applied',
        originalText: 'precise sentence',
        replacementText: 'clear phrase',
        modelOutput: 'Made the selected phrase more direct.'
      })
      expect(service.listInlineEdits(project.id)).toHaveLength(1)
      expect(readFileSync(join(appDataPath!, 'main.tex'), 'utf8')).toContain(
        'A clear phrase for revision.'
      )

      const rolledBack = await service.rollbackInlineEdit(edit.id)
      expect(rolledBack.status).toBe('rolled-back')
      expect(readFileSync(join(appDataPath!, 'main.tex'), 'utf8')).toContain(
        'A precise sentence for revision.'
      )
      const nextEdit = await service.sendInlineEdit({
        projectId: project.id,
        selection,
        instruction: 'Make this direct again.'
      })
      expect(service.listInlineEdits(project.id)).toHaveLength(2)
      service.deleteInlineEdit(edit.id)
      expect(service.listInlineEdits(project.id)).toEqual([nextEdit])
    } finally {
      store.close()
    }
  })

  it('refuses stale source before creating or clearing the hidden chat', async () => {
    const { store, project, session } = createInlineProject('Original source.\n')
    const terminals = {
      startLatexInlineChat: vi.fn().mockResolvedValue(session),
      runLatexInlineEditExec: vi.fn().mockResolvedValue({
        exitCode: 0,
        output: ''
      })
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
      expect(terminals.runLatexInlineEditExec).not.toHaveBeenCalled()
    } finally {
      store.close()
    }
  })

  it('rejects and restores edits outside the exact selection', async () => {
    const { store, project, session } = createInlineProject('Target sentence.\n')
    writeFileSync(join(appDataPath!, 'side.tex'), 'Keep this source.\n')
    const terminals = {
      startLatexInlineChat: vi.fn().mockResolvedValue(session),
      runLatexInlineEditExec: vi.fn().mockImplementation(async () => {
        writeFileSync(join(appDataPath!, 'main.tex'), 'Better sentence.\n')
        rmSync(join(appDataPath!, 'side.tex'))
        writeFileSync(join(appDataPath!, 'unexpected.tex'), 'Unexpected.\n')
        return {
          exitCode: 0,
          output:
            '{"type":"item.completed","item":{"type":"agent_message","text":"Changed more than requested."}}\r\n'
        }
      })
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
            endColumn: 7,
            text: 'Target'
          },
          instruction: 'Use a stronger word.'
        })
      ).rejects.toThrow('outside the selected range')
      expect(readFileSync(join(appDataPath!, 'main.tex'), 'utf8')).toBe(
        'Target sentence.\n'
      )
      expect(readFileSync(join(appDataPath!, 'side.tex'), 'utf8')).toBe(
        'Keep this source.\n'
      )
      expect(() => readFileSync(join(appDataPath!, 'unexpected.tex'))).toThrow()
      expect(service.listInlineEdits(project.id)[0]).toMatchObject({
        status: 'failed',
        modelOutput: 'Changed more than requested.'
      })
    } finally {
      store.close()
    }
  })

  it('launches a one-shot codex exec instead of the interactive TUI', async () => {
    const { store, session } = createInlineProject('Source text.\n')
    const manager = new TerminalManager(
      store,
      () => null,
      new ConversationIndexer(),
      new RemoteConversationIndexer()
    )
    const internals = manager as unknown as {
      connectionHasTmux(): boolean
      tmuxSessionExists(): boolean
      launch(...args: unknown[]): void
      resolveLatexInlineExec(
        sessionId: string,
        result: { exitCode: number; output: string }
      ): void
    }
    vi.spyOn(internals, 'connectionHasTmux').mockReturnValue(true)
    vi.spyOn(internals, 'tmuxSessionExists').mockReturnValue(false)
    let command = ''
    vi.spyOn(internals, 'launch').mockImplementation((...args) => {
      command = String(args[7])
      queueMicrotask(() =>
        internals.resolveLatexInlineExec(session.id, {
          exitCode: 0,
          output: 'finished'
        })
      )
    })

    try {
      await expect(
        manager.runLatexInlineEditExec(session.id, 'Apply the edit.')
      ).resolves.toEqual({ exitCode: 0, output: 'finished' })
      expect(command).toContain('codex exec')
      expect(command).toContain('--sandbox workspace-write')
      expect(command).toContain('--output-last-message')
      expect(command).toContain(LATEX_INLINE_OUTPUT_START)
      expect(command).toContain('Apply the edit.')
      expect(command).not.toContain('/clear')
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
