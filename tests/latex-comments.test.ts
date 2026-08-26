import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

  afterEach(() => {
    if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
    appDataPath = null
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

  it('persists exact source anchors and deletes only the comment', () => {
    const { store, project, service } = createProject()
    try {
      const comment = service.createComment({
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

      expect(service.listComments(project.id)).toEqual([comment])
      expect(comment).toMatchObject({
        path: 'main.tex',
        selectedText: 'Comment',
        startLine: 2,
        startColumn: 1,
        body: 'Consider a more specific verb.'
      })
      expect(comment.prefixContext).toContain('Opening paragraph.')
      expect(comment.suffixContext).toContain(' this phrase.')

      service.deleteComment(comment.id)
      expect(service.listComments(project.id)).toEqual([])
    } finally {
      store.close()
    }
  })

  it('refuses to attach a comment to stale source coordinates', () => {
    const { store, project, service } = createProject()
    try {
      expect(() =>
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
      ).toThrow('selected source changed')
      expect(service.listComments(project.id)).toEqual([])
    } finally {
      store.close()
    }
  })
})
