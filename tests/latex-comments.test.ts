import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LatexProjectService } from '../src/main/latex-project-service'
import { Store } from '../src/main/store'
import type { TerminalManager } from '../src/main/terminal-manager'
import {
  loadLatexManuscriptLayout,
  saveLatexManuscriptLayout
} from '../src/renderer/src/lib/latexManuscriptLayout'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe('LaTeX manuscript layout', () => {
  it('remembers document-map and comment-margin visibility per project', () => {
    const storage = new MemoryStorage()
    expect(loadLatexManuscriptLayout('paper-a', storage)).toEqual({
      mapHidden: false,
      commentsHidden: true,
      autoSave: true
    })

    saveLatexManuscriptLayout(
      'paper-a',
      { mapHidden: true, commentsHidden: false, autoSave: false },
      storage
    )

    expect(loadLatexManuscriptLayout('paper-a', storage)).toEqual({
      mapHidden: true,
      commentsHidden: false,
      autoSave: false
    })
    expect(loadLatexManuscriptLayout('paper-b', storage)).toEqual({
      mapHidden: false,
      commentsHidden: true,
      autoSave: true
    })
  })
})

describe('LaTeX selection comments', () => {
  let appDataPath: string | null = null
  let secondClientDataPath: string | null = null

  afterEach(() => {
    if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
    if (secondClientDataPath) {
      rmSync(secondClientDataPath, { recursive: true, force: true })
    }
    appDataPath = null
    secondClientDataPath = null
  })

  function createProject() {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-latex-comment-'))
    mkdirSync(join(appDataPath, 'context'))
    writeFileSync(
      join(appDataPath, 'main.tex'),
      'Opening paragraph.\nComment this phrase.\nClosing paragraph.\n'
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
    const service = new LatexProjectService(
      store,
      {} as TerminalManager
    )
    return { store, project, service }
  }

  it('persists exact source anchors in the project for another client', async () => {
    const { store, project, service } = createProject()
    try {
      const comment = await service.createComment({
        projectId: project.id,
        selection: {
          path: 'main.tex',
          startLine: 2,
          startColumn: 1,
          endLine: 2,
          endColumn: 8,
          text: 'Comment'
        },
        body: 'Consider a more specific verb.'
      })

      expect(await service.listComments(project.id)).toEqual([comment])
      expect(comment).toMatchObject({
        path: 'main.tex',
        selectedText: 'Comment',
        startLine: 2,
        startColumn: 1,
        body: 'Consider a more specific verb.'
      })
      expect(comment.prefixContext).toContain('Opening paragraph.')
      expect(comment.suffixContext).toContain(' this phrase.')

      const shared = JSON.parse(
        readFileSync(
          join(appDataPath!, '.panepilot', 'latex-comments.json'),
          'utf8'
        )
      ) as { version: number; comments: Array<Record<string, unknown>> }
      expect(shared.version).toBe(1)
      expect(shared.comments).toHaveLength(1)
      expect(shared.comments[0]).not.toHaveProperty('projectId')

      secondClientDataPath = mkdtempSync(
        join(tmpdir(), 'panepilot-latex-comment-client-')
      )
      const secondStore = new Store(secondClientDataPath)
      try {
        secondStore.syncConnections([])
        const secondProject = secondStore.createProject({
          type: 'latex',
          name: 'Paper on another client',
          connectionId: 'local',
          folder: appDataPath!,
          repositoryUrl: null,
          latex: {
            mainFile: 'main.tex',
            overleafUrl: null,
            contextFolder: 'context'
          }
        })
        const secondService = new LatexProjectService(
          secondStore,
          {} as TerminalManager
        )
        expect(await secondService.listComments(secondProject.id)).toEqual([
          { ...comment, projectId: secondProject.id }
        ])
      } finally {
        secondStore.close()
      }

      await service.deleteComment(project.id, comment.id)
      expect(await service.listComments(project.id)).toEqual([])
    } finally {
      store.close()
    }
  })

  it('refuses to attach a comment to stale source coordinates', async () => {
    const { store, project, service } = createProject()
    try {
      await expect(
        service.createComment({
          projectId: project.id,
          selection: {
            path: 'main.tex',
            startLine: 2,
            startColumn: 1,
            endLine: 2,
            endColumn: 8,
            text: 'Changed'
          },
          body: 'This should not be saved.'
        })
      ).rejects.toThrow('selected source changed')
      expect(await service.listComments(project.id)).toEqual([])
    } finally {
      store.close()
    }
  })

  it('migrates legacy client-local comments when the shared file is absent', async () => {
    const { store, project, service } = createProject()
    try {
      const legacy = store.createLatexComment({
        projectId: project.id,
        path: 'main.tex',
        body: 'Legacy note',
        selectedText: 'Comment',
        startLine: 2,
        startColumn: 1,
        endLine: 2,
        endColumn: 8,
        prefixContext: 'Opening paragraph.\n',
        suffixContext: ' this phrase.\nClosing paragraph.\n'
      })

      expect(await service.listComments(project.id)).toEqual([legacy])
      const shared = JSON.parse(
        readFileSync(
          join(appDataPath!, '.panepilot', 'latex-comments.json'),
          'utf8'
        )
      ) as { comments: Array<{ id: string }> }
      expect(shared.comments.map((comment) => comment.id)).toEqual([legacy.id])
    } finally {
      store.close()
    }
  })
})
