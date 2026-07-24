import { describe, expect, it } from 'vitest'
import {
  diffLatexFile,
  parseLatexOutline
} from '../src/main/latex-project-service'
import { normalizeProjectRelativePath } from '../src/main/latex-paths'

describe('LaTeX outline parsing', () => {
  it('maps main-file section declarations to their included source files', () => {
    const sections = parseLatexOutline(
      {
        'main.tex': String.raw`
\documentclass{article}
\begin{document}
\section{Introduction}
\label{sec:intro}
\input{sections/introduction}
\section{Method}
\input{sections/method.tex}
\end{document}
`,
        'sections/introduction.tex': 'Introductory prose.\nA second line.',
        'sections/method.tex': 'Method prose.'
      },
      'main.tex'
    )

    expect(
      sections.map(({ title, sourceFile, startLine, endLine }) => ({
        title,
        sourceFile,
        startLine,
        endLine
      }))
    ).toEqual([
      {
        title: 'Introduction',
        sourceFile: 'sections/introduction.tex',
        startLine: 1,
        endLine: 2
      },
      {
        title: 'Method',
        sourceFile: 'sections/method.tex',
        startLine: 1,
        endLine: 1
      }
    ])
  })

  it('discovers section commands inside included files and ignores comments', () => {
    const sections = parseLatexOutline(
      {
        'paper.tex': String.raw`
% \section{Not part of the paper}
\input{chapters/results}
`,
        'chapters/results.tex': String.raw`
\section{Results}
Text.
\subsection{Ablations}
More text.
`
      },
      'paper.tex'
    )

    expect(sections.map(({ title, level, sourceFile }) => ({ title, level, sourceFile }))).toEqual([
      { title: 'Results', level: 2, sourceFile: 'chapters/results.tex' },
      { title: 'Ablations', level: 3, sourceFile: 'chapters/results.tex' }
    ])
  })
})

describe('LaTeX edit highlighting', () => {
  it('reports exact modified lines', () => {
    const changes = diffLatexFile(
      'sections/results.tex',
      ['Alpha', 'Beta value', 'Remove this', 'Omega'].join('\n'),
      ['Alpha', 'Beta improved', 'Add this', 'Omega'].join('\n')
    )

    expect(changes).not.toBeNull()
    expect(changes?.modifications).toBe(2)
    expect(changes?.highlights[0]).toMatchObject({
      kind: 'modified',
      startLine: 2,
      originalText: 'Beta value',
      currentText: 'Beta improved'
    })
  })

  it('reports inserted lines at their current source position', () => {
    const changes = diffLatexFile('main.tex', 'First\nLast', 'First\nNew line\nLast')
    expect(changes?.additions).toBe(1)
    expect(changes?.highlights).toContainEqual(
      expect.objectContaining({
        kind: 'added',
        startLine: 2,
        currentText: 'New line'
      })
    )
  })

  it('keeps deletions visible even though their source text is gone', () => {
    const changes = diffLatexFile('main.tex', 'First\nDeleted\nLast', 'First\nLast')
    expect(changes?.deletions).toBe(1)
    expect(changes?.highlights).toContainEqual(
      expect.objectContaining({
        kind: 'deleted',
        startLine: 2,
        originalText: 'Deleted'
      })
    )
  })
})

describe('LaTeX project paths', () => {
  it('normalizes relative TeX files and rejects traversal', () => {
    expect(normalizeProjectRelativePath('./paper/main.tex', 'Main file', { extension: '.tex' }))
      .toBe('paper/main.tex')
    expect(() =>
      normalizeProjectRelativePath('../outside.tex', 'Main file', { extension: '.tex' })
    ).toThrow('inside the project folder')
  })
})
